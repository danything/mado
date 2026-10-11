// mado-tray: タスクトレイに mado(サービス)の状態を出す。サインイン時に起動する(MSI が HKLM の Run に登録する)。
//
// 状態は mado の状態の口(http://127.0.0.1:8788/status。`--port <番号>` で変える)を 5 秒ごとに見る。動いていればアプリのアイコン、
// 聞けなければ注意のアイコンにして、ツールチップに版・つないでいる数・証明書の残り日数を出す。
// 右クリックのメニュー: 画面を開く / 今すぐ更新を確かめる / サービスを再起動(UAC)/ ログを開く(UAC)/ 終了。
// 自動更新でサービスと exe が新しい版になったら、自分も起こし直す(RestartIfUpdated)。
//
// WinForms は Native AOT に対応していないので、Win32(Shell_NotifyIcon と隠しウィンドウ)を直接呼ぶ。
// ウィンドウはメッセージ専用ではなく普通の(見えない)トップレベルにして、MSI の更新のときに Restart Manager が
// WM_CLOSE で閉じられるようにする(閉じたあと RegisterApplicationRestart で起こし直してもらう)。

using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Mado.Tray;

internal static unsafe partial class Program
{
    const uint WmTrayIcon = 0x8000 + 1; // WM_APP + 1
    const int MenuOpen = 1, MenuUpdate = 2, MenuRestart = 3, MenuLog = 4, MenuExit = 9;

    static nint hwnd, hInstance, appIcon, warnIcon, mutex;
    static uint taskbarCreated;
    static string[] startArgs = [];
    /// <summary>自分の版と exe の置き場所(起動したときのもの)</summary>
    static readonly string? exePath = Environment.ProcessPath;
    /// <summary>
    /// 自分の版。属性から取れなければ、起動したときの exe のファイルの版。どちらも取れなければ null で、
    /// 起こし直しはしない(「0.0.0 より新しい」で 5 秒ごとに起こし直し続けないため)
    /// </summary>
    static readonly string? ownVersion = Known(typeof(Program).Assembly
            .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion)
        ?? (exePath is null ? null : Known(System.Diagnostics.FileVersionInfo.GetVersionInfo(exePath).ProductVersion));

    static string? Known(string? v) => string.IsNullOrEmpty(v) || VersionOf(v) == "v0.0.0" ? null : VersionOf(v);

    /// <summary>最後に聞けた状態(聞けなければ null)。背景で取ってきて、タイマーで反映する</summary>
    static volatile StatusView? status;
    static volatile bool fetching;
    static bool? wasUp;

    internal sealed record StatusView(string Version, string Origin, int Sessions, int? CertDaysLeft, string? Latest, bool Available);

    [STAThread]
    static int Main(string[] args)
    {
        // mado.json の status.port を変えたときは、Run の登録に --port <番号> を足す
        var i = Array.IndexOf(args, "--port");
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var port)) Net.Base = $"http://127.0.0.1:{port}";
        startArgs = args;
        // 二重に起動しない(サインインし直したときなど)。起こし直すときは、新しいほうを起動する前に放す
        mutex = CreateMutexW(0, 0, "Local\\mado-tray");
        if (Marshal.GetLastPInvokeError() == 183 /* ERROR_ALREADY_EXISTS */) return 0;
        // MSI の更新で Restart Manager に閉じられたら、終わったあとに起こし直してもらう
        // 起こし直すときも同じ引数(--port)で
        RegisterApplicationRestart(args.Length > 0 ? string.Join(' ', args) : null, 0);

        hInstance = GetModuleHandleW(null);
        // exe に埋め込んだアイコン(ApplicationIcon。資源の ID は 32512)。無ければ Windows の標準のもの
        appIcon = LoadImageW(hInstance, 32512, 1 /* IMAGE_ICON */, GetSystemMetrics(49), GetSystemMetrics(50), 0);
        if (appIcon == 0) appIcon = LoadIconW(0, 32512 /* IDI_APPLICATION */);
        warnIcon = LoadIconW(0, 32515 /* IDI_WARNING */);

        fixed (char* cls = "mado-tray")
        {
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)sizeof(WNDCLASSEXW),
                lpfnWndProc = &WndProc,
                hInstance = hInstance,
                lpszClassName = cls,
            };
            if (RegisterClassExW(&wc) == 0) return 1;
            hwnd = CreateWindowExW(0, cls, cls, 0, 0, 0, 0, 0, 0, 0, hInstance, 0);
        }
        if (hwnd == 0) return 1;
        taskbarCreated = RegisterWindowMessageW("TaskbarCreated");

        AddIcon();
        Fetch();
        SetTimer(hwnd, 1, 5000, 0);

        MSG msg;
        while (GetMessageW(&msg, 0, 0, 0) > 0)
        {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        return 0;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvStdcall)])]
    static nint WndProc(nint h, uint msg, nint w, nint l)
    {
        try
        {
            switch (msg)
            {
                case WmTrayIcon:
                    switch ((uint)(l & 0xffff))
                    {
                        case 0x0203: // WM_LBUTTONDBLCLK
                            Open(status?.Origin);
                            break;
                        case 0x0205: // WM_RBUTTONUP
                        case 0x007B: // WM_CONTEXTMENU
                            ShowMenu();
                            break;
                    }
                    return 0;
                case 0x0113: // WM_TIMER
                    Apply();
                    Fetch();
                    return 0;
                case 0x0011: // WM_QUERYENDSESSION(サインアウトや Restart Manager)。閉じてよい
                    return 1;
                case 0x0016: // WM_ENDSESSION
                case 0x0010: // WM_CLOSE
                    Quit();
                    return 0;
                case 0x0002: // WM_DESTROY
                    PostQuitMessage(0);
                    return 0;
            }
            // エクスプローラーが落ちて起き直したら、アイコンを出し直す
            if (msg == taskbarCreated && taskbarCreated != 0) AddIcon();
        }
        catch
        {
            // 例外をネイティブの呼び出し元に返さない
        }
        return DefWindowProcW(h, msg, w, l);
    }

    // --- 状態 ---------------------------------------------------------------------------------------

    static void Fetch()
    {
        if (fetching) return;
        fetching = true;
        // Net.Status は例外を出さない(聞けなければ null)
        _ = Net.Status().ContinueWith(t =>
        {
            status = t.Result;
            fetching = false;
        }, TaskScheduler.Default);
    }
    /// <summary>取ってきた状態をアイコンとツールチップに出す。止まった・戻ったときは通知も出す</summary>
    static void Apply()
    {
        var s = status;
        var up = s is not null;
        var tip = s is null
            ? "mado: 止まっている(サービスに聞けない)"
            : $"mado {s.Version}\nつないでいる: {s.Sessions}"
              + (s.CertDaysLeft is { } d ? $"\n証明書: 残り {d} 日" : "")
              + (s.Available ? $"\n新しい版 {s.Latest} がある" : "");
        Modify(up ? appIcon : warnIcon, tip);
        if (wasUp is { } before && before != up)
            Balloon(up ? "mado が動き出した" : "mado が止まった", up ? $"{s!.Version}" : "サービス mado に聞けない。右クリックから再起動できる", !up);
        wasUp = up;
        if (s is not null) RestartIfUpdated(s.Version);
    }

    /// <summary>
    /// サービスが新しい版になり、置き場所の mado-tray.exe も新しい版に入れ替わっていたら、自分を起こし直す。
    /// サービスが入れる MSI は、サインインしている人のトレイを閉じられない(動いている exe は名前を変えて残り、
    /// 新しい exe が置かれる)ので、トレイは古いまま動き続けてしまう。同じ引数(--port)で起動して、自分は終わる
    /// </summary>
    static void RestartIfUpdated(string serviceVersion)
    {
        if (exePath is null || ownVersion is null || !Newer(serviceVersion, ownVersion)) return;
        var onDisk = VersionOf(System.Diagnostics.FileVersionInfo.GetVersionInfo(exePath).ProductVersion);
        if (!Newer(onDisk, ownVersion)) return;
        // 新しいほうが二重起動の確認で弾かれないよう、先に放す
        CloseHandle(mutex);
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exePath, startArgs) { UseShellExecute = false });
        }
        catch
        {
            // 起動できなければ、放したものを取り直してこのまま動き続ける(次の確認でまた試す)
            mutex = CreateMutexW(0, 0, "Local\\mado-tray");
            return;
        }
        Quit();
    }

    /// <summary>"0.5.1+abc" / "v0.5.1" を "v0.5.1" に</summary>
    static string VersionOf(string? v) => "v" + (v ?? "0.0.0").TrimStart('v').Split('+')[0];

    static bool Newer(string a, string b) =>
        Version.TryParse(a.TrimStart('v').Split('-')[0], out var x) && Version.TryParse(b.TrimStart('v').Split('-')[0], out var y) && x > y;

    // --- メニュー -----------------------------------------------------------------------------------

    static void ShowMenu()
    {
        var s = status;
        var menu = CreatePopupMenu();
        AppendMenuW(menu, s is null ? 1u /* MF_GRAYED */ : 0, MenuOpen, s is null ? "画面を開く" : $"{new Uri(s.Origin).Host} を開く");
        AppendMenuW(menu, s is null ? 1u : 0, MenuUpdate, "今すぐ更新を確かめる");
        AppendMenuW(menu, 0x800 /* MF_SEPARATOR */, 0, null);
        AppendMenuW(menu, 0, MenuRestart, "サービスを再起動する…");
        AppendMenuW(menu, 0, MenuLog, "ログを開く…");
        AppendMenuW(menu, 0x800, 0, null);
        AppendMenuW(menu, 0, MenuExit, "終了");
        POINT p;
        GetCursorPos(&p);
        // 前に出しておかないと、メニューの外をクリックしても閉じない
        SetForegroundWindow(hwnd);
        var cmd = TrackPopupMenu(menu, 0x100 /* TPM_RETURNCMD */ | 0x80 /* TPM_NONOTIFY */ | 0x2 /* TPM_RIGHTBUTTON */, p.X, p.Y, 0, hwnd, 0);
        PostMessageW(hwnd, 0, 0, 0);
        DestroyMenu(menu);
        switch (cmd)
        {
            case MenuOpen: Open(s?.Origin); break;
            case MenuUpdate: UpdateNow(); break;
            case MenuRestart:
                // 止めて起こすには管理者が要る(UAC)
                ShellExecuteW(0, "runas", "powershell.exe", "-NoProfile -WindowStyle Hidden -Command Restart-Service mado", null, 0);
                break;
            case MenuLog:
                // ログは SYSTEM と Administrators だけが読める(UAC)
                ShellExecuteW(0, "runas", "notepad.exe",
                    $"\"{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "mado", "logs", "mado.log")}\"", null, 1);
                break;
            case MenuExit: Quit(); break;
        }
    }

    static void Open(string? url)
    {
        if (url is { Length: > 0 }) ShellExecuteW(0, "open", url, null, null, 1);
    }

    // Net.UpdateNow は例外を出さない(失敗も通知の文にする)
    static void UpdateNow() => _ = Net.UpdateNow().ContinueWith(t => Balloon(t.Result.Title, t.Result.Text, t.Result.Warn), TaskScheduler.Default);
    // --- アイコン -----------------------------------------------------------------------------------

    static NOTIFYICONDATAW Data(uint flags)
    {
        var d = new NOTIFYICONDATAW { cbSize = (uint)sizeof(NOTIFYICONDATAW), hWnd = hwnd, uID = 1, uFlags = flags };
        return d;
    }

    static void AddIcon()
    {
        var d = Data(0x1 /* NIF_MESSAGE */ | 0x2 /* NIF_ICON */ | 0x4 /* NIF_TIP */);
        d.uCallbackMessage = WmTrayIcon;
        d.hIcon = appIcon;
        Copy("mado", d.szTip, 128);
        Shell_NotifyIconW(0 /* NIM_ADD */, &d);
    }

    static void Modify(nint icon, string tip)
    {
        var d = Data(0x2 | 0x4);
        d.hIcon = icon;
        Copy(tip, d.szTip, 128);
        Shell_NotifyIconW(1 /* NIM_MODIFY */, &d);
    }

    static void Balloon(string title, string text, bool warning)
    {
        var d = Data(0x10 /* NIF_INFO */);
        Copy(text, d.szInfo, 256);
        Copy(title, d.szInfoTitle, 64);
        d.dwInfoFlags = warning ? 2u /* NIIF_WARNING */ : 1u /* NIIF_INFO */;
        Shell_NotifyIconW(1, &d);
    }

    static void Quit()
    {
        var d = Data(0);
        Shell_NotifyIconW(2 /* NIM_DELETE */, &d);
        DestroyWindow(hwnd);
    }

    static void Copy(string s, char* dst, int size)
    {
        var n = Math.Min(s.Length, size - 1);
        for (var i = 0; i < n; i++) dst[i] = s[i];
        dst[n] = '\0';
    }

    // --- Win32 --------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public nint hwnd;
        public uint message;
        public nint wParam, lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WNDCLASSEXW
    {
        public uint cbSize, style;
        public delegate* unmanaged[Stdcall]<nint, uint, nint, nint, nint> lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public nint hInstance, hIcon, hCursor, hbrBackground;
        public char* lpszMenuName, lpszClassName;
        public nint hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public nint hWnd;
        public uint uID, uFlags, uCallbackMessage;
        public nint hIcon;
        public fixed char szTip[128];
        public uint dwState, dwStateMask;
        public fixed char szInfo[256];
        public uint uVersion;
        public fixed char szInfoTitle[64];
        public uint dwInfoFlags;
        public Guid guidItem;
        public nint hBalloonIcon;
    }

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
    private static partial nint CreateMutexW(nint attributes, int initialOwner, string name);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint GetModuleHandleW(string? name);

    [LibraryImport("kernel32.dll")]
    private static partial int CloseHandle(nint handle);

    [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int RegisterApplicationRestart(string? commandLine, uint flags);

    [LibraryImport("user32.dll")]
    private static partial nint LoadImageW(nint instance, nint name, uint type, int cx, int cy, uint load);

    [LibraryImport("user32.dll")]
    private static partial nint LoadIconW(nint instance, nint name);

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);

    [LibraryImport("user32.dll")]
    private static partial ushort RegisterClassExW(WNDCLASSEXW* wc);

    [LibraryImport("user32.dll")]
    private static partial nint CreateWindowExW(uint exStyle, char* className, char* windowName, uint style,
        int x, int y, int w, int h, nint parent, nint menu, nint instance, nint param);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial uint RegisterWindowMessageW(string name);

    [LibraryImport("user32.dll")]
    private static partial nint DefWindowProcW(nint hwnd, uint msg, nint w, nint l);

    [LibraryImport("user32.dll")]
    private static partial int GetMessageW(MSG* msg, nint hwnd, uint min, uint max);

    [LibraryImport("user32.dll")]
    private static partial int TranslateMessage(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial nint DispatchMessageW(MSG* msg);

    [LibraryImport("user32.dll")]
    private static partial void PostQuitMessage(int code);

    [LibraryImport("user32.dll")]
    private static partial int PostMessageW(nint hwnd, uint msg, nint w, nint l);

    [LibraryImport("user32.dll")]
    private static partial int DestroyWindow(nint hwnd);

    [LibraryImport("user32.dll")]
    private static partial nint SetTimer(nint hwnd, nint id, uint ms, nint proc);

    [LibraryImport("user32.dll")]
    private static partial nint CreatePopupMenu();

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int AppendMenuW(nint menu, uint flags, nint id, string? text);

    [LibraryImport("user32.dll")]
    private static partial int TrackPopupMenu(nint menu, uint flags, int x, int y, int reserved, nint hwnd, nint rect);

    [LibraryImport("user32.dll")]
    private static partial int DestroyMenu(nint menu);

    [LibraryImport("user32.dll")]
    private static partial int GetCursorPos(POINT* p);

    [LibraryImport("user32.dll")]
    private static partial int SetForegroundWindow(nint hwnd);

    [LibraryImport("shell32.dll")]
    private static partial int Shell_NotifyIconW(uint message, NOTIFYICONDATAW* data);

    [LibraryImport("shell32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint ShellExecuteW(nint hwnd, string? verb, string file, string? parameters, string? dir, int show);
}

/// <summary>状態の口との話。await は unsafe の文脈では書けないので、Program とは分ける</summary>
internal static class Net
{
    /// <summary>状態の口。既定は 8788(mado.json の status.port の既定と同じ)。--port で変える</summary>
    public static string Base = "http://127.0.0.1:8788";
    static readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(3) };

    public static async Task<Program.StatusView?> Status()
    {
        try
        {
            using var doc = JsonDocument.Parse(await http.GetStringAsync($"{Base}/status"));
            var r = doc.RootElement;
            var u = r.TryGetProperty("update", out var up) ? up : default;
            return new Program.StatusView(
                r.GetProperty("version").GetString() ?? "?",
                r.GetProperty("origin").GetString() ?? "",
                r.GetProperty("sessions").GetInt32(),
                r.TryGetProperty("certDaysLeft", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt32() : null,
                u.ValueKind == JsonValueKind.Object && u.TryGetProperty("latest", out var lt) ? lt.GetString() : null,
                u.ValueKind == JsonValueKind.Object && u.TryGetProperty("available", out var av) && av.GetBoolean());
        }
        catch
        {
            return null;
        }
    }

    /// <summary>今すぐ更新を確かめる。通知に出す (題, 本文, 注意か)</summary>
    public static async Task<(string Title, string Text, bool Warn)> UpdateNow()
    {
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, $"{Base}/update");
            req.Headers.Add("x-mado", "1");
            using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            using var res = await client.SendAsync(req);
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var started = doc.RootElement.GetProperty("started").GetBoolean();
            var st = doc.RootElement.GetProperty("state");
            var latest = st.TryGetProperty("latest", out var l) ? l.GetString() : null;
            var error = st.TryGetProperty("error", out var e) ? e.GetString() : null;
            if (started) return ("mado を更新する", $"{latest} を入れている。少しのあいだ止まる", false);
            if (error is not null) return ("mado の更新", error, true);
            if (st.TryGetProperty("available", out var a) && a.GetBoolean())
                return ("mado の更新", $"{latest} があるが、つないでいる人がいるので後で入れる", false);
            return ("mado の更新", $"新しい版は無い(最新は {latest})", false);
        }
        catch (Exception ex)
        {
            return ("mado の更新", $"確かめられなかった: {ex.Message}", true);
        }
    }
}
