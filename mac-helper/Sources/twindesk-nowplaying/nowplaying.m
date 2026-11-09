// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on this Mac, from any app (a browser's YouTube too), with its artwork: macOS's own Now
// Playing (MediaRemote.framework). Since macOS 15.4 it answers only Apple's own processes, so this
// is a library loaded into /usr/bin/perl (shared/web/pcmedia.js starts it):
//   /usr/bin/perl -e 'require DynaLoader; DynaLoader::dl_load_file($ARGV[0], 0) or die; sleep 1 while 1' <this dylib>
// Loaded, it starts a thread of its own (the loader's lock is held until the constructor returns,
// and MediaRemote loads more as it goes) and perl sleeps: one JSON line on stdout whenever what plays changes
//   {title, artist, album, app, bundle, playing, duration, art: 'data:image/jpeg;base64,…' | ''}
// ({} when nothing plays), and commands one a line on stdin: play, pause, toggle, next, previous.
// stdin closed (TwinDesk gone): it exits.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#include <dlfcn.h>

typedef void (*GetInfoFn)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetPlayingFn)(dispatch_queue_t, void (^)(Boolean));
typedef void (*GetClientFn)(dispatch_queue_t, void (^)(id));
typedef NSString *(*ClientStrFn)(id);
typedef void (*RegisterFn)(dispatch_queue_t);
typedef Boolean (*SendFn)(int, NSDictionary *);

static GetInfoFn getInfo;
static GetPlayingFn getPlaying;
static GetClientFn getClient;
static ClientStrFn clientBundle, clientParent;
static SendFn sendCommand;
static dispatch_queue_t q;
static NSString *last = @"";
static NSString *lastArtKey = @"";
static NSString *lastArt = @"";
static BOOL busy, again;

static NSString *appName(NSString *bundle) {
    if (!bundle.length) return @"";
    NSURL *u = [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:bundle];
    NSString *n = u ? [[NSFileManager defaultManager] displayNameAtPath:u.path] : nil;
    if ([n hasSuffix:@".app"]) n = [n substringToIndex:n.length - 4];
    return n ?: @"";
}

// The artwork, at most 300 px a side as JPEG (a phone's Lock Screen and Media page need no more).
static NSString *thumb(NSData *d) {
    if (!d.length) return @"";
    CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)d, NULL);
    if (!src) return @"";
    NSDictionary *o = @{ (id)kCGImageSourceCreateThumbnailFromImageAlways: @YES, (id)kCGImageSourceThumbnailMaxPixelSize: @300,
                         (id)kCGImageSourceCreateThumbnailWithTransform: @YES };
    CGImageRef img = CGImageSourceCreateThumbnailAtIndex(src, 0, (__bridge CFDictionaryRef)o);
    CFRelease(src);
    if (!img) return @"";
    NSMutableData *out = [NSMutableData data];
    CGImageDestinationRef dst = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)out, CFSTR("public.jpeg"), 1, NULL);
    if (dst) {
        CGImageDestinationAddImage(dst, img, (__bridge CFDictionaryRef)@{ (id)kCGImageDestinationLossyCompressionQuality: @0.75 });
        CGImageDestinationFinalize(dst);
        CFRelease(dst);
    }
    CGImageRelease(img);
    return out.length ? [@"data:image/jpeg;base64," stringByAppendingString:[out base64EncodedStringWithOptions:0]] : @"";
}

static void emit(NSDictionary *d) {
    NSData *j = [NSJSONSerialization dataWithJSONObject:d options:0 error:nil];
    NSString *s = j ? [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding] : @"{}";
    if ([s isEqualToString:last]) return;
    last = s;
    printf("%s\n", s.UTF8String);
    fflush(stdout);
}

static void read_(void) {
    if (busy) { again = YES; return; }
    busy = YES;
    getInfo(q, ^(NSDictionary *info) {
        getPlaying(q, ^(Boolean playing) {
            getClient(q, ^(id client) {
                NSString *b = client && clientParent ? clientParent(client) : nil;
                if (!b.length && client && clientBundle) b = clientBundle(client);
                NSString *title = [info[@"kMRMediaRemoteNowPlayingInfoTitle"] description] ?: @"";
                if (!title.length) {
                    emit(@{});
                } else {
                    NSData *art = info[@"kMRMediaRemoteNowPlayingInfoArtworkData"];
                    if (![art isKindOfClass:[NSData class]]) art = nil;
                    // Some updates leave the artwork out: the same track keeps the one it had.
                    NSString *track = [NSString stringWithFormat:@"%@|%@", title, info[@"kMRMediaRemoteNowPlayingInfoArtist"] ?: @""];
                    if (art) {
                        NSString *ak = [NSString stringWithFormat:@"%@|%lu", track, (unsigned long)art.length];
                        if (![ak isEqualToString:lastArtKey]) { lastArtKey = ak; lastArt = thumb(art); }
                    } else if (![lastArtKey hasPrefix:[track stringByAppendingString:@"|"]]) {
                        lastArtKey = @""; lastArt = @"";
                    }
                    NSNumber *dur = info[@"kMRMediaRemoteNowPlayingInfoDuration"];
                    emit(@{ @"title": title,
                            @"artist": [info[@"kMRMediaRemoteNowPlayingInfoArtist"] description] ?: @"",
                            @"album": [info[@"kMRMediaRemoteNowPlayingInfoAlbum"] description] ?: @"",
                            @"bundle": b ?: @"", @"app": appName(b),
                            @"playing": @(playing ? YES : NO),
                            @"duration": [dur isKindOfClass:[NSNumber class]] ? @(round(dur.doubleValue)) : @0,
                            @"art": lastArt });
                }
                busy = NO;
                if (again) { again = NO; read_(); }
            });
        });
    });
}

static void commands(void) {
    // MediaRemote's commands: 0 play, 1 pause, 2 toggle, 4 next, 5 previous.
    NSDictionary *codes = @{ @"play": @0, @"pause": @1, @"toggle": @2, @"next": @4, @"previous": @5 };
    char line[64];
    while (fgets(line, sizeof line, stdin)) {
        NSString *c = [[NSString stringWithUTF8String:line] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        NSNumber *n = codes[c];
        if (n && sendCommand) sendCommand(n.intValue, nil);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), q, ^{ read_(); });
    }
    exit(0); // stdin closed: TwinDesk is gone
}

static void run(void) {
    void *h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
    getInfo = (GetInfoFn)dlsym(h, "MRMediaRemoteGetNowPlayingInfo");
    getPlaying = (GetPlayingFn)dlsym(h, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
    getClient = (GetClientFn)dlsym(h, "MRMediaRemoteGetNowPlayingClient");
    clientBundle = (ClientStrFn)dlsym(h, "MRNowPlayingClientGetBundleIdentifier");
    clientParent = (ClientStrFn)dlsym(h, "MRNowPlayingClientGetParentAppBundleIdentifier");
    sendCommand = (SendFn)dlsym(h, "MRMediaRemoteSendCommand");
    RegisterFn reg = (RegisterFn)dlsym(h, "MRMediaRemoteRegisterForNowPlayingNotifications");
    if (!getInfo || !getPlaying || !getClient) { printf("{\"error\":\"no MediaRemote\"}\n"); fflush(stdout); exit(2); }
    q = dispatch_queue_create("td.nowplaying", DISPATCH_QUEUE_SERIAL);
    if (reg) reg(q);
    for (NSString *n in @[ @"kMRMediaRemoteNowPlayingInfoDidChangeNotification", @"kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification",
                           @"kMRMediaRemoteNowPlayingApplicationDidChangeNotification" ]) {
        [[NSNotificationCenter defaultCenter] addObserverForName:n object:nil queue:nil usingBlock:^(NSNotification *_) { dispatch_async(q, ^{ read_(); }); }];
    }
    // Some apps don't announce every change: a look every 3 s as well.
    dispatch_source_t t = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
    dispatch_source_set_timer(t, DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC, NSEC_PER_SEC / 2);
    dispatch_source_set_event_handler(t, ^{ read_(); });
    dispatch_resume(t);
    commands();
}

__attribute__((constructor)) static void start(void) {
    [NSThread detachNewThreadWithBlock:^{ run(); }];
}
