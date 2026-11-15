// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The monitor with Windows' own pointer (its accessibility size included), as native BGRA textures
// shared with Electron, without resizing. Windows 11: Windows Graphics Capture without its border.
// Windows 10 draws a yellow border around every WGC capture and no app can turn it off, so there it
// is Desktop Duplication, with the pointer shape Windows hands it (at the size it draws) put on each
// frame. WGC, border and all, only when duplication can't start (another GPU's monitor, rotated).
// Arguments: parent PID, x, y, width, height, fps [, auto | wgc | dda].
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_5.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using Clock = std::chrono::steady_clock;

struct Slot {
    com_ptr<ID3D11Texture2D> texture;
    HANDLE local = nullptr, remote = nullptr;
    bool busy = false;
};

// The textures Electron reads. Every member but the slots' busy flags belongs to the capturing thread;
// the mutex guards the flags, `stopped` and stdout.
struct Capture {
    std::array<Slot, 3> slots;
    std::mutex mutex;
    bool stopped = false, first = true;
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    com_ptr<ID3D11Query> copied;
    int width = 0, height = 0;
    const char* backend = "wgc";

    size_t FreeSlot() const {
        size_t index = 0;
        while (index < slots.size() && slots[index].busy) ++index;
        return index;
    }

    // Holding the mutex: the GPU's write is complete before Chromium opens the texture on its device.
    void Publish(size_t index, int64_t timestamp) {
        context->End(copied.get());
        context->Flush();
        HRESULT ready;
        while ((ready = context->GetData(copied.get(), nullptr, 0, 0)) == S_FALSE) SwitchToThread();
        check_hresult(ready);
        slots[index].busy = true;
        if (first) {
            first = false;
            std::cout << "{\"ready\":true,\"backend\":\"" << backend << "\",\"width\":" << width
                << ",\"height\":" << height << "}" << std::endl;
        }
        std::cout << "{\"frame\":" << index << ",\"handle\":\""
            << reinterpret_cast<uintptr_t>(slots[index].remote) << "\",\"width\":" << width
            << ",\"height\":" << height << ",\"timestamp\":" << timestamp << "}" << std::endl;
    }

    // Holding the mutex.
    void Fail(const std::string& message) {
        if (stopped) return;
        stopped = true;
        std::cout << "{\"error\":\"" << message << "\"}" << std::endl;
    }
};

// Microseconds on the clock WGC's SystemRelativeTime uses (QueryPerformanceCounter).
static int64_t Now() {
    LARGE_INTEGER t, f;
    QueryPerformanceCounter(&t);
    QueryPerformanceFrequency(&f);
    return t.QuadPart / f.QuadPart * 1000000 + t.QuadPart % f.QuadPart * 1000000 / f.QuadPart;
}

// WGC can leave out its border here (Windows 11).
static bool BorderlessWgc() {
    try {
        return winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired");
    } catch (...) { return false; }
}

// A frame this soon after the last would be over the frame rate.
static bool TooSoon(Clock::time_point last, Clock::time_point now, Clock::duration interval) {
    return last != Clock::time_point::min() && now - last < interval * 9 / 10;
}
// The pointer Desktop Duplication hands over, kept as given (DXGI_OUTDUPL_POINTER_SHAPE_INFO).
struct Pointer {
    std::vector<uint8_t> shape;
    DXGI_OUTDUPL_POINTER_SHAPE_INFO info{};
    int x = 0, y = 0;
    bool visible = false;
    int Height() const { return info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? info.Height / 2 : info.Height; }
};

// What the pointer leaves of a desktop pixel (BGRA). Color: alpha blended. Masked color: alpha 0
// replaces the pixel, 0xFF XORs it. Monochrome: AND mask, then XOR mask.
static uint32_t Blend(const Pointer& p, int sx, int sy, uint32_t under) {
    const auto& s = p.info;
    if (s.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const int h = p.Height();
        const uint8_t bit = 0x80 >> (sx % 8);
        const bool andBit = p.shape[sy * s.Pitch + sx / 8] & bit, xorBit = p.shape[(sy + h) * s.Pitch + sx / 8] & bit;
        return ((under & (andBit ? 0xFFFFFFFFu : 0xFF000000u)) ^ (xorBit ? 0x00FFFFFFu : 0u)) | 0xFF000000u;
    }
    uint32_t src;
    std::memcpy(&src, &p.shape[sy * s.Pitch + sx * 4], 4);
    const uint32_t a = src >> 24;
    if (s.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR)
        return (a ? (under ^ src) : src) | 0xFF000000u;
    if (a == 0) return under;
    if (a == 255) return src | 0xFF000000u;
    uint32_t out = 0xFF000000u;
    for (int shift = 0; shift < 24; shift += 8) {
        const uint32_t c = ((src >> shift & 0xFF) * a + (under >> shift & 0xFF) * (255 - a) + 127) / 255;
        out |= c << shift;
    }
    return out;
}

struct Duplication {
    com_ptr<IDXGIOutput1> output;
    com_ptr<IDXGIOutputDuplication> dup;
    com_ptr<ID3D11Texture2D> desktop, staging;
    UINT stagingWidth = 0, stagingHeight = 0;
    bool haveDesktop = false;
    Pointer pointer;
    std::vector<uint32_t> pixels;

    // The monitor's output on the default adapter (the GPU Chromium opens the textures on), else throws.
    static com_ptr<IDXGIOutput1> Find(HMONITOR monitor, com_ptr<IDXGIAdapter1>& adapter) {
        com_ptr<IDXGIFactory1> factory;
        check_hresult(CreateDXGIFactory1(guid_of<IDXGIFactory1>(), factory.put_void()));
        check_hresult(factory->EnumAdapters1(0, adapter.put()));
        for (UINT o = 0;; ++o) {
            com_ptr<IDXGIOutput> output;
            if (adapter->EnumOutputs(o, output.put()) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC desc{};
            if (FAILED(output->GetDesc(&desc)) || desc.Monitor != monitor) continue;
            if (desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED)
                throw std::runtime_error("rotated monitor");
            return output.as<IDXGIOutput1>();
        }
        throw std::runtime_error("monitor not on the default GPU");
    }

    // Windows converts HDR and 10-bit desktops to BGRA for DuplicateOutput1 (Windows 10 1703+).
    void Open(ID3D11Device* device, int width, int height) {
        dup = nullptr;
        static const DXGI_FORMAT formats[] = { DXGI_FORMAT_B8G8R8A8_UNORM };
        if (auto output5 = output.try_as<IDXGIOutput5>())
            check_hresult(output5->DuplicateOutput1(device, 0, 1, formats, dup.put()));
        else
            check_hresult(output->DuplicateOutput(device, dup.put()));
        DXGI_OUTDUPL_DESC desc{};
        dup->GetDesc(&desc);
        if (static_cast<int>(desc.ModeDesc.Width) != width || static_cast<int>(desc.ModeDesc.Height) != height)
            throw std::runtime_error("The captured monitor changed size");
    }

    // Duplication hands over a picture only when something on the monitor changes: on a still screen the
    // first one never comes. Start from a GDI copy of the monitor (once, without the pointer: the
    // duplication's own pointer is drawn over it).
    void Seed(ID3D11DeviceContext* context, const RECT& monitor) {
        const int w = monitor.right - monitor.left, h = monitor.bottom - monitor.top;
        HDC screen = GetDC(nullptr);
        HDC memory = CreateCompatibleDC(screen);
        BITMAPINFO bi{};
        bi.bmiHeader.biSize = sizeof(bi.bmiHeader); bi.bmiHeader.biWidth = w; bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
        void* bits = nullptr;
        HBITMAP bitmap = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
        bool copied = false;
        if (bitmap) {
            HGDIOBJ old = SelectObject(memory, bitmap);
            copied = BitBlt(memory, 0, 0, w, h, screen, monitor.left, monitor.top, SRCCOPY | CAPTUREBLT) != FALSE;
            GdiFlush();
            if (copied) {
                auto* px = static_cast<uint32_t*>(bits);
                for (size_t i = 0, n = static_cast<size_t>(w) * h; i < n; ++i) px[i] |= 0xFF000000u; // GDI leaves alpha 0
                context->UpdateSubresource(desktop.get(), 0, nullptr, bits, w * 4, 0);
            }
            SelectObject(memory, old);
            DeleteObject(bitmap);
        }
        DeleteDC(memory);
        ReleaseDC(nullptr, screen);
        if (copied) haveDesktop = true;
    }

    // One AcquireNextFrame: true when the picture or the pointer changed.
    bool Next(ID3D11DeviceContext* context, UINT timeout, HRESULT& hr) {
        DXGI_OUTDUPL_FRAME_INFO info{};
        com_ptr<IDXGIResource> resource;
        hr = dup->AcquireNextFrame(timeout, &info, resource.put());
        if (FAILED(hr)) return false;
        bool changed = false;
        if (info.LastPresentTime.QuadPart) {
            auto frame = resource.as<ID3D11Texture2D>();
            D3D11_TEXTURE2D_DESC desc{};
            frame->GetDesc(&desc);
            if (desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) { dup->ReleaseFrame(); throw std::runtime_error("desktop format"); }
            context->CopyResource(desktop.get(), frame.get());
            haveDesktop = changed = true;
        }
        if (info.LastMouseUpdateTime.QuadPart) {
            pointer.visible = info.PointerPosition.Visible != FALSE;
            pointer.x = info.PointerPosition.Position.x;
            pointer.y = info.PointerPosition.Position.y;
            changed = true;
        }
        if (info.PointerShapeBufferSize) {
            pointer.shape.resize(info.PointerShapeBufferSize);
            UINT needed = 0;
            hr = dup->GetFramePointerShape(info.PointerShapeBufferSize, pointer.shape.data(), &needed, &pointer.info);
            if (FAILED(hr)) { pointer.shape.clear(); pointer.info = {}; }
            changed = true;
        }
        hr = dup->ReleaseFrame();
        return changed;
    }

    // The desktop, then the pointer drawn over the rectangle it covers (read back, blended on the CPU).
    void Compose(ID3D11Device* device, ID3D11DeviceContext* context, ID3D11Texture2D* target, int width, int height) {
        context->CopyResource(target, desktop.get());
        const auto& p = pointer;
        if (!p.visible || p.shape.empty()) return;
        const int w = p.info.Width, h = p.Height();
        const int left = std::max(0, p.x), top = std::max(0, p.y);
        const int right = std::min(width, p.x + w), bottom = std::min(height, p.y + h);
        if (left >= right || top >= bottom) return;
        if (!staging || stagingWidth < static_cast<UINT>(w) || stagingHeight < static_cast<UINT>(h)) {
            D3D11_TEXTURE2D_DESC desc{};
            desc.Width = w; desc.Height = h; desc.MipLevels = 1; desc.ArraySize = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
            desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            staging = nullptr;
            check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
            stagingWidth = w; stagingHeight = h;
        }
        D3D11_BOX box{ static_cast<UINT>(left), static_cast<UINT>(top), 0, static_cast<UINT>(right), static_cast<UINT>(bottom), 1 };
        context->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, desktop.get(), 0, &box);
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
        const int cw = right - left, ch = bottom - top;
        pixels.resize(static_cast<size_t>(cw) * ch);
        for (int y = 0; y < ch; ++y) {
            const auto* row = reinterpret_cast<const uint32_t*>(static_cast<const uint8_t*>(mapped.pData) + y * mapped.RowPitch);
            for (int x = 0; x < cw; ++x)
                pixels[y * cw + x] = Blend(p, left + x - p.x, top + y - p.y, row[x]);
        }
        context->Unmap(staging.get(), 0);
        context->UpdateSubresource(target, 0, &box, pixels.data(), cw * 4, 0);
    }
};
// Desktop Duplication on its own thread until `stopped`. A frame on every change, at most `fps`, and the
// last one again each second when nothing moves (native-screen.js ends a capture silent for 3 s).
static void RunDuplication(Capture& cap, Duplication& dd, int fps) {
    const auto interval = std::chrono::microseconds(1000000 / fps);
    auto last = Clock::time_point::min();
    auto lost = Clock::time_point::min();
    bool dirty = false;
    try {
        for (;;) {
            {
                std::lock_guard<std::mutex> lock(cap.mutex);
                if (cap.stopped) return;
            }
            const auto now = Clock::now();
            UINT timeout = 250;
            if (dirty && last != Clock::time_point::min()) {
                const auto wait = std::chrono::duration_cast<std::chrono::milliseconds>(last + interval - now).count();
                timeout = static_cast<UINT>(std::clamp<long long>(wait, 0, 250));
            }
            HRESULT hr = S_OK;
            if (!dd.dup) hr = DXGI_ERROR_ACCESS_LOST;
            else if (dd.Next(cap.context.get(), timeout, hr)) dirty = true;
            if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
                // A mode change, the secure desktop (UAC, Ctrl+Alt+Del), a full-screen game: open it again.
                // Meanwhile the last picture goes out each second; after 10 s the capture ends.
                if (lost == Clock::time_point::min()) lost = now;
                try { dd.Open(cap.device.get(), cap.width, cap.height); lost = Clock::time_point::min(); }
                catch (const hresult_error&) {
                    if (now - lost > std::chrono::seconds(10)) throw;
                    std::this_thread::sleep_for(std::chrono::milliseconds(200));
                }
            } else if (FAILED(hr) && hr != DXGI_ERROR_WAIT_TIMEOUT) {
                throw_hresult(hr);
            }
            if (!dd.haveDesktop) continue;
            const auto at = Clock::now();
            const bool heartbeat = last == Clock::time_point::min() || at - last > std::chrono::seconds(1);
            if (!(dirty && !TooSoon(last, at, interval)) && !heartbeat) continue;
            size_t index;
            {
                std::lock_guard<std::mutex> lock(cap.mutex);
                if (cap.stopped) return;
                index = cap.FreeSlot();
            }
            if (index == cap.slots.size()) { // the encoder still owns every texture
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            }
            dd.Compose(cap.device.get(), cap.context.get(), cap.slots[index].texture.get(), cap.width, cap.height);
            std::lock_guard<std::mutex> lock(cap.mutex);
            if (cap.stopped) return;
            cap.Publish(index, Now());
            last = at;
            dirty = false;
        }
    } catch (const hresult_error& error) {
        std::lock_guard<std::mutex> lock(cap.mutex);
        cap.Fail("Desktop Duplication failed: " + std::to_string(static_cast<unsigned>(error.code())));
    } catch (const std::exception&) {
        std::lock_guard<std::mutex> lock(cap.mutex);
        cap.Fail("The captured monitor changed");
    }
}

int main(int argc, char** argv) {
    HANDLE parent = nullptr;
    Capture cap;
    try {
        if (argc != 7 && argc != 8) throw std::invalid_argument("Expected parent PID, x, y, width, height, fps and a mode");
        auto number = [](const char* value) {
            size_t end = 0;
            int result = std::stoi(value, &end);
            if (value[end]) throw std::invalid_argument("Invalid number");
            return result;
        };
        const int pid = number(argv[1]), x = number(argv[2]), y = number(argv[3]);
        const int askedWidth = number(argv[4]), askedHeight = number(argv[5]), fps = number(argv[6]);
        const std::string mode = argc == 8 ? argv[7] : "auto";
        if (pid <= 0 || askedWidth < 2 || askedHeight < 2 || askedWidth > 32768 || askedHeight > 32768 || fps < 1 || fps > 240 ||
            (mode != "auto" && mode != "wgc" && mode != "dda"))
            throw std::invalid_argument("Invalid capture bounds, frame rate or mode");
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        init_apartment(apartment_type::multi_threaded);
        parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid);
        if (!parent) throw_last_error();

        HMONITOR monitor = MonitorFromPoint({ x + askedWidth / 2, y + askedHeight / 2 }, MONITOR_DEFAULTTONULL);
        MONITORINFO monitorInfo{ sizeof(MONITORINFO) };
        if (!monitor || !GetMonitorInfo(monitor, &monitorInfo)) throw std::runtime_error("The selected monitor changed");
        // Electron's DIP-to-pixel conversion can be off by a few pixels on a scaled monitor that is not at
        // the origin (1920 x 1200 at 125% came back as 1920 x 1202). Capture the monitor's real pixels.
        const RECT& real = monitorInfo.rcMonitor;
        const int width = cap.width = real.right - real.left, height = cap.height = real.bottom - real.top;
        const int slack = 4;
        if (std::abs(real.left - x) > slack || std::abs(real.top - y) > slack ||
            std::abs(width - askedWidth) > slack || std::abs(height - askedHeight) > slack)
            throw std::runtime_error("The selected monitor changed");

        // Duplication needs the device on the monitor's own adapter; WGC takes any (the default one).
        Duplication dd;
        com_ptr<IDXGIAdapter1> adapter;
        bool duplicate = mode == "dda" || (mode == "auto" && !BorderlessWgc());
        std::string why;
        // In a Remote Desktop session the client draws the pointer: duplication never reports one.
        if (duplicate && mode == "auto" && GetSystemMetrics(SM_REMOTESESSION)) { why = "Remote Desktop session"; duplicate = false; }
        if (duplicate) {
            try { dd.output = Duplication::Find(monitor, adapter); }
            catch (const std::exception& e) { why = e.what(); duplicate = false; adapter = nullptr; }
            catch (const hresult_error& e) { why = "DXGI " + std::to_string(static_cast<unsigned>(e.code())); duplicate = false; adapter = nullptr; }
            if (!duplicate && mode == "dda") throw std::runtime_error("dda");
        }
        check_hresult(D3D11CreateDevice(adapter.get(), adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, cap.device.put(), nullptr, cap.context.put()));

        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = width; desc.Height = height; desc.MipLevels = 1; desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
        for (auto& slot : cap.slots) {
            check_hresult(cap.device->CreateTexture2D(&desc, nullptr, slot.texture.put()));
            check_hresult(slot.texture.as<IDXGIResource1>()->CreateSharedHandle(nullptr,
                DXGI_SHARED_RESOURCE_READ, nullptr, &slot.local));
            if (!DuplicateHandle(GetCurrentProcess(), slot.local, parent, &slot.remote, 0, FALSE, DUPLICATE_SAME_ACCESS))
                throw_last_error();
        }
        D3D11_QUERY_DESC query{ D3D11_QUERY_EVENT, 0 };
        check_hresult(cap.device->CreateQuery(&query, cap.copied.put()));

        if (duplicate) {
            try {
                dd.Open(cap.device.get(), width, height);
                D3D11_TEXTURE2D_DESC copy = desc;
                copy.BindFlags = 0; copy.MiscFlags = 0;
                check_hresult(cap.device->CreateTexture2D(&copy, nullptr, dd.desktop.put()));
            } catch (const hresult_error& e) {
                // E_ACCESSDENIED on the secure desktop, DXGI_ERROR_UNSUPPORTED on some hybrid laptops, too many duplicators.
                if (mode == "dda") throw;
                why = "DuplicateOutput " + std::to_string(static_cast<unsigned>(e.code()));
                duplicate = false;
            }
        }
        if (!why.empty()) std::cerr << "Desktop Duplication unavailable (" << why << "): WGC, with its border" << std::endl;

        if (duplicate) {
            cap.backend = "dda";
            dd.Seed(cap.context.get(), real);
            std::cerr << "Desktop Duplication started" << (dd.haveDesktop ? "" : " (no first picture yet)") << std::endl;
            std::thread worker([&] { RunDuplication(cap, dd, fps); });
            std::string line;
            while (std::getline(std::cin, line)) {
                std::istringstream command(line);
                size_t index;
                if (command >> index && index < cap.slots.size()) {
                    std::lock_guard<std::mutex> lock(cap.mutex);
                    cap.slots[index].busy = false;
                }
            }
            {
                std::lock_guard<std::mutex> lock(cap.mutex);
                cap.stopped = true;
            }
            worker.join();
        } else {
            if (!GraphicsCaptureSession::IsSupported()) throw std::runtime_error("Windows Graphics Capture is unavailable");
            com_ptr<IInspectable> inspectable;
            check_hresult(CreateDirect3D11DeviceFromDXGIDevice(cap.device.as<IDXGIDevice>().get(), inspectable.put()));
            auto direct3d = inspectable.as<IDirect3DDevice>();
            GraphicsCaptureItem item{ nullptr };
            auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
            check_hresult(interop->CreateForMonitor(monitor, guid_of<GraphicsCaptureItem>(), put_abi(item)));
            if (item.Size().Width != width || item.Size().Height != height)
                throw std::runtime_error("Native capture size differs from the selected monitor");
            auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(direct3d,
                DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, item.Size());
            auto session = pool.CreateCaptureSession(item);
            session.IsCursorCaptureEnabled(true);
            try { session.IsBorderRequired(false); } catch (const hresult_error&) { }
            auto last = Clock::time_point::min();
            const auto interval = std::chrono::microseconds(1000000 / fps);
            auto token = pool.FrameArrived([&](auto const& sender, auto const&) {
                std::lock_guard<std::mutex> lock(cap.mutex);
                if (cap.stopped) return;
                try {
                    auto frame = sender.TryGetNextFrame();
                    if (!frame) return;
                    if (frame.ContentSize().Width != width || frame.ContentSize().Height != height)
                        throw std::runtime_error("The captured monitor changed size");
                    auto now = Clock::now();
                    if (TooSoon(last, now, interval)) return;
                    const size_t index = cap.FreeSlot();
                    if (index == cap.slots.size()) return; // the encoder still owns every texture
                    auto access = frame.Surface().template as<IDirect3DDxgiInterfaceAccess>();
                    com_ptr<ID3D11Texture2D> source;
                    check_hresult(access->GetInterface(guid_of<ID3D11Texture2D>(), source.put_void()));
                    D3D11_BOX box{ 0, 0, 0, static_cast<UINT>(width), static_cast<UINT>(height), 1 };
                    cap.context->CopySubresourceRegion(cap.slots[index].texture.get(), 0, 0, 0, 0, source.get(), 0, &box);
                    cap.Publish(index, frame.SystemRelativeTime().count() / 10);
                    last = now;
                } catch (const hresult_error& error) {
                    cap.Fail("WGC frame failed: " + std::to_string(static_cast<unsigned>(error.code())));
                } catch (const std::exception&) {
                    cap.Fail("The captured monitor changed");
                }
            });
            session.StartCapture();
            std::string line;
            while (std::getline(std::cin, line)) {
                std::istringstream command(line);
                size_t index;
                if (command >> index && index < cap.slots.size()) {
                    std::lock_guard<std::mutex> lock(cap.mutex);
                    cap.slots[index].busy = false;
                }
            }
            {
                std::lock_guard<std::mutex> lock(cap.mutex);
                cap.stopped = true;
            }
            pool.FrameArrived(token);
            session.Close();
            pool.Close();
        }
    } catch (const hresult_error& error) {
        std::lock_guard<std::mutex> lock(cap.mutex);
        std::cout << "{\"error\":\"Native capture startup failed: " << static_cast<unsigned>(error.code()) << "\"}" << std::endl;
    } catch (const std::exception&) {
        std::lock_guard<std::mutex> lock(cap.mutex);
        std::cout << "{\"error\":\"Invalid or unavailable native capture\"}" << std::endl;
    }
    for (auto& slot : cap.slots) {
        if (slot.remote && parent) {
            HANDLE temporary = nullptr;
            if (DuplicateHandle(parent, slot.remote, GetCurrentProcess(), &temporary, 0, FALSE,
                DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) CloseHandle(temporary);
        }
        if (slot.local) CloseHandle(slot.local);
    }
    if (parent) CloseHandle(parent);
}
