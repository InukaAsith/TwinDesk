# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Builds TwinDesk's iOS shortcuts (web/shortcuts/*.shortcut). Each asks for its link when it is added
# (an import question): the page copies that device's link first, so adding one is a tap and a paste.
# Unsigned output here; sign them on a Mac (sign.sh) before shipping: iOS only imports signed ones.
import plistlib, uuid, sys, os

def tok(uid, name):
    return {'Value': {'string': '￼', 'attachmentsByRange': {'{0, 1}': {'OutputUUID': uid, 'Type': 'ActionOutput', 'OutputName': name}}}, 'WFSerializationType': 'WFTextTokenString'}
def var(uid, name):
    return {'Value': {'OutputUUID': uid, 'Type': 'ActionOutput', 'OutputName': name}, 'WFSerializationType': 'WFTextTokenAttachment'}
def act(ident, params):
    return {'WFWorkflowActionIdentifier': ident, 'WFWorkflowActionParameters': params}

def url_action(uid):
    return act('is.workflow.actions.url', {'UUID': uid, 'WFURLActionURL': 'https://'})
QUESTION = 'Paste the link TwinDesk copied for you (TwinDesk › Shortcuts).'

def workflow(actions, url_index, color, glyph, share=None):
    w = {
        'WFWorkflowClientVersion': '2605.0.5', 'WFWorkflowMinimumClientVersion': 900, 'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': color, 'WFWorkflowIconGlyphNumber': glyph},
        'WFWorkflowActions': actions, 'WFWorkflowImportQuestions': [{'ActionIndex': url_index, 'Category': 'Parameter', 'DefaultValue': 'https://', 'ParameterKey': 'WFURLActionURL', 'Text': QUESTION}],
        'WFWorkflowTypes': ['ActionExtension'] if share else [], 'WFWorkflowInputContentItemClasses': share or ['WFStringContentItem'],
        'WFWorkflowHasShortcutInputVariables': bool(share), 'WFQuickActionSurfaces': [],
    }
    return w

def notify(uid, name):
    return act('is.workflow.actions.notification', {'WFNotificationActionBody': tok(uid, name), 'WFNotificationActionTitle': 'TwinDesk'})

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
U = lambda: str(uuid.uuid4()).upper()

# Copy from the computer: its clipboard onto this phone's.
u1, d1 = U(), U()
copy_from = workflow([url_action(u1), act('is.workflow.actions.downloadurl', {'UUID': d1, 'WFURL': tok(u1, 'URL'), 'WFHTTPMethod': 'GET'}), act('is.workflow.actions.setclipboard', {'WFInput': var(d1, 'Contents of URL')})], 0, 463140863, 59446)

# Send clipboard: this phone's clipboard onto the computer's.
c2, u2, d2 = U(), U(), U()
send_clip = workflow([act('is.workflow.actions.getclipboard', {'UUID': c2}), url_action(u2),
    act('is.workflow.actions.downloadurl', {'UUID': d2, 'WFURL': tok(u2, 'URL'), 'WFHTTPMethod': 'POST', 'WFHTTPBodyType': 'File', 'WFRequestVariable': var(c2, 'Clipboard')}), notify(d2, 'Contents of URL')], 1, 4282601983, 59446)

# Send to the computer, from the share sheet: files and photos to its Downloads.
u3, d3 = U(), U()
ext = {'Value': {'Type': 'ExtensionInput'}, 'WFSerializationType': 'WFTextTokenAttachment'}
send_files = workflow([url_action(u3), act('is.workflow.actions.downloadurl', {'UUID': d3, 'WFURL': tok(u3, 'URL'), 'WFHTTPMethod': 'POST', 'WFHTTPBodyType': 'File', 'WFRequestVariable': ext}), act('is.workflow.actions.notification', {'WFNotificationActionBody': 'Sent', 'WFNotificationActionTitle': 'TwinDesk'})], 0, 4271458815, 59511,
    share=['WFImageContentItem', 'WFGenericFileContentItem', 'WFPDFContentItem', 'WFAVAssetContentItem', 'WFPhotoMediaContentItem'])

# Send to Drop, from the share sheet: links and text as a message.
u4, d4 = U(), U()
send_drop = workflow([url_action(u4), act('is.workflow.actions.downloadurl', {'UUID': d4, 'WFURL': tok(u4, 'URL'), 'WFHTTPMethod': 'POST', 'WFHTTPBodyType': 'File', 'WFRequestVariable': ext}), notify(d4, 'Contents of URL')], 0, 4292093695, 59650,
    share=['WFURLContentItem', 'WFStringContentItem', 'WFRichTextContentItem', 'WFSafariWebPageContentItem'])

for name, w in [('Copy from computer', copy_from), ('Send clipboard', send_clip), ('Send to computer', send_files), ('Send to Drop', send_drop)]:
    with open(os.path.join(out, name + '.shortcut'), 'wb') as f:
        plistlib.dump(w, f, fmt=plistlib.FMT_BINARY)
print('ok')
