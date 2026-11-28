// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Windows 11's first-level right-click menu: "TwinDesk" with
//   Send to <device>   files and folders, one per paired device (the same as Send to's shortcuts,
//                      windows/sendto.js): TwinDesk --send-files [--send-to=<id>] <paths>
//   Share folder       one folder, or a folder's background: TwinDesk --td share <folder>
//                      (shared/foldermenu.js)
// An IExplorerCommand, as Windows 11 wants for that menu, in TwinDesk's sparse package
// (AppxManifest.xml: windows.fileExplorerContextMenus + a surrogate COM server). It keeps nothing and
// knows nothing of its own: what to start, the labels (in the app's language) and the devices are
// read from HKCU\Software\TwinDesk\ShellMenu, which the app writes (windows/shellmenu.js). Nothing in
// it runs except when Explorer shows the menu or an entry is clicked.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shobjidl_core.h>
#include <shlwapi.h>
#include <string>
#include <vector>
#include <new>
#include <algorithm>
#include <cwctype>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "advapi32.lib")

// {6F3B2A1E-8D4C-4B7A-9E21-5C3D7A1042B1}: as AppxManifest.xml
static const CLSID CLSID_TwinDeskMenu = { 0x6f3b2a1e, 0x8d4c, 0x4b7a, { 0x9e, 0x21, 0x5c, 0x3d, 0x7a, 0x10, 0x42, 0xb1 } };
static const wchar_t KEY[] = L"Software\\TwinDesk\\ShellMenu";
static const size_t MAX_DEVICES = 10; // as the mesh (MAX_DEVICES)
static const size_t MAX_ITEMS = 1000; // as Send to takes them
static const size_t MAX_CMD = 32000; // CreateProcess' limit is 32767
static LONG g_objects = 0;
static LONG g_locks = 0;

static std::wstring regStr(const wchar_t* name) {
  DWORD size = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, KEY, name, RRF_RT_REG_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS || size < sizeof(wchar_t) || size > 64 * 1024) return L"";
  std::wstring s(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(HKEY_CURRENT_USER, KEY, name, RRF_RT_REG_SZ, nullptr, &s[0], &size) != ERROR_SUCCESS) return L"";
  s.resize(wcslen(s.c_str()));
  return s;
}

struct Device { std::wstring id, name; };

// Devices: REG_MULTI_SZ, "id<TAB>name" each ("" id: the one paired computer, one-to-one).
static std::vector<Device> devices() {
  std::vector<Device> out;
  DWORD size = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, KEY, L"Devices", RRF_RT_REG_MULTI_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS || size < sizeof(wchar_t) || size > 64 * 1024) return out;
  std::vector<wchar_t> buf(size / sizeof(wchar_t) + 2, L'\0');
  if (RegGetValueW(HKEY_CURRENT_USER, KEY, L"Devices", RRF_RT_REG_MULTI_SZ, nullptr, buf.data(), &size) != ERROR_SUCCESS) return out;
  for (const wchar_t* p = buf.data(); *p && out.size() < MAX_DEVICES; p += wcslen(p) + 1) {
    std::wstring line(p);
    size_t tab = line.find(L'\t');
    if (tab == std::wstring::npos || tab + 1 >= line.size()) continue;
    Device d{ line.substr(0, tab), line.substr(tab + 1) };
    bool ok = d.id.size() <= 64;
    for (wchar_t c : d.id) ok = ok && (iswalnum(c) || c == L'.' || c == L'_' || c == L'-');
    if (ok) out.push_back(d);
  }
  return out;
}

// The selection's file system paths (none when an item isn't a file or folder on disk).
static std::vector<std::wstring> paths(IShellItemArray* items) {
  std::vector<std::wstring> out;
  DWORD n = 0;
  if (!items || FAILED(items->GetCount(&n)) || n == 0 || n > MAX_ITEMS) return out;
  for (DWORD i = 0; i < n; i++) {
    IShellItem* it = nullptr;
    if (FAILED(items->GetItemAt(i, &it))) return {};
    PWSTR p = nullptr;
    HRESULT hr = it->GetDisplayName(SIGDN_FILESYSPATH, &p);
    it->Release();
    if (FAILED(hr) || !p) return {};
    out.emplace_back(p);
    CoTaskMemFree(p);
  }
  return out;
}

static bool isDir(const std::wstring& p) {
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

// One argument as the C runtime reads it back: paths can't hold a quote, but a trailing backslash
// (C:\) would escape the closing one.
static std::wstring quote(const std::wstring& p) {
  std::wstring q = L"\"" + p;
  if (!p.empty() && p.back() == L'\\') q += L'\\';
  return q + L"\"";
}

static void launch(const std::wstring& args) {
  std::wstring cmd = regStr(L"Command"); // "C:\...\TwinDesk.exe" (and a dev copy's app folder)
  if (cmd.empty()) return;
  cmd += L" " + args;
  if (cmd.size() > MAX_CMD) return;
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  STARTUPINFOW si = { sizeof(si) };
  PROCESS_INFORMATION pi = {};
  if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
    AllowSetForegroundWindow(pi.dwProcessId);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

static std::wstring label(const wchar_t* name, const wchar_t* fallback) {
  std::wstring s = regStr(name);
  return s.empty() ? fallback : s;
}

class Command : public IExplorerCommand {
 public:
  Command() { InterlockedIncrement(&g_objects); }
  virtual ~Command() { InterlockedDecrement(&g_objects); }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
      *ppv = static_cast<IExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs_);
    if (!r) delete this;
    return r;
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) override {
    *icon = nullptr;
    std::wstring s = regStr(L"Icon");
    return s.empty() ? E_NOTIMPL : SHStrDupW(s.c_str(), icon);
  }
  IFACEMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* tip) override { *tip = nullptr; return E_NOTIMPL; }
  IFACEMETHODIMP GetCanonicalName(GUID* g) override { *g = GUID_NULL; return S_OK; }
  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* f) override { *f = ECF_DEFAULT; return S_OK; }
  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** e) override { *e = nullptr; return E_NOTIMPL; }

 private:
  ULONG refs_ = 1;
};

// One entry: Send to a device, or Share folder.
class Leaf : public Command {
 public:
  Leaf(bool share, Device d) : share_(share), dev_(std::move(d)) {}

  IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override {
    std::wstring t;
    if (share_) t = label(L"ShareLabel", L"Share folder");
    else {
      t = label(L"SendLabel", L"Send to {name}");
      size_t at = t.find(L"{name}");
      if (at != std::wstring::npos) t.replace(at, 6, dev_.name);
    }
    return SHStrDupW(t.c_str(), name);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray* items, LPWSTR* icon) override {
    *icon = nullptr;
    return SHStrDupW(share_ ? L"imageres.dll,-1023" : L"shell32.dll,-16761", icon);
  }

  IFACEMETHODIMP GetState(IShellItemArray* items, BOOL slowOk, EXPCMDSTATE* state) override {
    *state = ECS_HIDDEN;
    if (!share_) {
      if (!paths(items).empty()) *state = ECS_ENABLED;
      return S_OK;
    }
    // A folder's attributes may be slow to read (a network share): Explorer asks again when it may be.
    if (!slowOk) return E_PENDING;
    std::vector<std::wstring> p = paths(items);
    if (p.size() == 1 && isDir(p[0])) *state = ECS_ENABLED;
    return S_OK;
  }

  IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
    std::vector<std::wstring> p = paths(items);
    if (p.empty()) return S_OK;
    if (share_) {
      if (p.size() == 1 && isDir(p[0])) launch(L"--td share " + quote(p[0]));
      return S_OK;
    }
    std::wstring args = L"--send-files";
    if (!dev_.id.empty()) args += L" --send-to=" + dev_.id;
    for (const auto& one : p) args += L" " + quote(one);
    launch(args);
    return S_OK;
  }

 private:
  bool share_;
  Device dev_;
};

class Enum : public IEnumExplorerCommand {
 public:
  explicit Enum(std::vector<IExplorerCommand*> list) : list_(std::move(list)) { InterlockedIncrement(&g_objects); }
  virtual ~Enum() {
    for (auto* c : list_) c->Release();
    InterlockedDecrement(&g_objects);
  }
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IEnumExplorerCommand) {
      *ppv = static_cast<IEnumExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&refs_);
    if (!r) delete this;
    return r;
  }
  IFACEMETHODIMP Next(ULONG n, IExplorerCommand** out, ULONG* got) override {
    ULONG i = 0;
    for (; i < n && at_ < list_.size(); i++, at_++) {
      out[i] = list_[at_];
      out[i]->AddRef();
    }
    if (got) *got = i;
    return i == n ? S_OK : S_FALSE;
  }
  IFACEMETHODIMP Skip(ULONG n) override { at_ = std::min(list_.size(), at_ + n); return at_ < list_.size() ? S_OK : S_FALSE; }
  IFACEMETHODIMP Reset() override { at_ = 0; return S_OK; }
  IFACEMETHODIMP Clone(IEnumExplorerCommand** e) override { *e = nullptr; return E_NOTIMPL; }

 private:
  ULONG refs_ = 1;
  std::vector<IExplorerCommand*> list_;
  size_t at_ = 0;
};

// "TwinDesk", with the entries under it; hidden when none of them applies.
class Root : public Command {
 public:
  IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override { return SHStrDupW(label(L"Title", L"TwinDesk").c_str(), name); }
  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* f) override { *f = ECF_HASSUBCOMMANDS; return S_OK; }
  IFACEMETHODIMP GetState(IShellItemArray* items, BOOL slowOk, EXPCMDSTATE* state) override {
    *state = ECS_HIDDEN;
    std::vector<std::wstring> p = paths(items);
    if (p.empty()) return S_OK;
    if (!devices().empty()) { *state = ECS_ENABLED; return S_OK; }
    if (p.size() != 1) return S_OK;
    if (!slowOk) return E_PENDING;
    if (isDir(p[0])) *state = ECS_ENABLED;
    return S_OK;
  }
  IFACEMETHODIMP Invoke(IShellItemArray*, IBindCtx*) override { return S_OK; }
  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** e) override {
    *e = nullptr;
    std::vector<IExplorerCommand*> list;
    for (auto& d : devices()) {
      auto* c = new (std::nothrow) Leaf(false, d);
      if (c) list.push_back(c);
    }
    auto* s = new (std::nothrow) Leaf(true, Device{});
    if (s) list.push_back(s);
    auto* en = new (std::nothrow) Enum(std::move(list));
    if (!en) return E_OUTOFMEMORY;
    *e = en;
    return S_OK;
  }
};

class Factory : public IClassFactory {
 public:
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override { return 2; } // a static object
  IFACEMETHODIMP_(ULONG) Release() override { return 1; }
  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (outer) return CLASS_E_NOAGGREGATION;
    auto* r = new (std::nothrow) Root();
    if (!r) return E_OUTOFMEMORY;
    HRESULT hr = r->QueryInterface(riid, ppv);
    r->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock) InterlockedIncrement(&g_locks);
    else InterlockedDecrement(&g_locks);
    return S_OK;
  }
};

static Factory g_factory;

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;
  if (!IsEqualCLSID(clsid, CLSID_TwinDeskMenu)) return CLASS_E_CLASSNOTAVAILABLE;
  return g_factory.QueryInterface(riid, ppv);
}

STDAPI DllCanUnloadNow() { return g_objects == 0 && g_locks == 0 ? S_OK : S_FALSE; }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(module);
  return TRUE;
}
