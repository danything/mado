// msquic を P/Invoke で直接呼ぶ層。
// System.Net.Quic は QUIC の datagram を宣言できず、輻輳制御も選べない。そのため msquic の API 表を自分で引く。
// 構造体の並びは msquic 2.6 の msquic.h に合わせる。64 bit(x64 / arm64)だけを考える。
// msquic はコールバックを自分のスレッドから呼ぶ。1 つの接続とその stream のコールバックは、同じスレッドで順に呼ばれる。
// ほかのスレッド(中継)からも触るので、接続ごとの Gate で包む。コールバックの中から呼ぶ msquic の API は、
// その場で別のコールバックを呼ぶことがある。Lock は同じスレッドなら入り直せるので、それで止まりはしない。
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Mado.Quic;

/// <summary>msquic の関数表と定数</summary>
internal static unsafe class MsQuic
{
    public const int StatusSuccess = 0;

    public const uint ParamGlobalLibraryVersion = 0x01000004;
    public const uint ParamConfigurationSettings = 0x03000000;
    public const uint ParamConnSettings = 0x05000004;
    public const uint ParamStreamId = 0x08000000;

    public const ushort CongestionCubic = 0;
    public const ushort CongestionBbr = 1;

    public const int CredentialTypePkcs12 = 6;

    public const int StreamOpenUnidirectional = 1;
    public const int StreamStartImmediate = 1;
    public const int StreamShutdownGraceful = 1;
    public const int StreamShutdownAbortReceive = 4;
    public const int StreamShutdownAbort = 6;
    public const int SendFlagFin = 4;

    static QuicApiTable* _api;
    static nint _lib;
    static readonly Lock OpenLock = new();

    public static QuicApiTable* Api => _api;

    /// <summary>Windows では msquic.dll、Linux では libmsquic.so.2 を読む。読めなければ例外</summary>
    public static void Open()
    {
        lock (OpenLock)
        {
            if (_api != null) return;
            string[] names = OperatingSystem.IsWindows()
                ? [Path.Combine(AppContext.BaseDirectory, "msquic.dll"), "msquic.dll"]
                : OperatingSystem.IsMacOS() ? ["libmsquic.dylib"] : ["libmsquic.so.2", "libmsquic.so"];
            foreach (var n in names)
                if (NativeLibrary.TryLoad(n, out _lib)) break;
            if (_lib == 0) throw new DllNotFoundException("msquic が見つからない: " + string.Join(", ", names));
            var open = (delegate* unmanaged[Cdecl]<uint, QuicApiTable**, int>)NativeLibrary.GetExport(_lib, "MsQuicOpenVersion");
            QuicApiTable* api;
            Check(open(2, &api), "MsQuicOpenVersion");
            _api = api;
        }
    }

    /// <summary>msquic の版。2.2 より前は BBR が無い</summary>
    public static string Version()
    {
        uint* v = stackalloc uint[4];
        uint len = 16;
        if (Failed(Api->GetParam(0, ParamGlobalLibraryVersion, &len, v))) return "?";
        return $"{v[0]}.{v[1]}.{v[2]}";
    }

    /// <summary>失敗の判定。Windows は HRESULT で負が失敗、Linux は errno で正が失敗</summary>
    public static bool Failed(int status) => OperatingSystem.IsWindows() ? status < 0 : status > 0;

    public static void Check(int status, string what)
    {
        if (Failed(status)) throw new QuicNativeException(what, status);
    }

    /// <summary>
    /// QUIC_ADDR を作る。中身は sockaddr_in / sockaddr_in6。null は全アドレス(AF_UNSPEC で IPv4 と IPv6 の両方)。
    /// AF_INET6 の値は OS で違う(Windows 23、Linux 10)
    /// </summary>
    public static void WriteAddress(byte* addr, IPAddress? ip, ushort port)
    {
        new Span<byte>(addr, 32).Clear();
        addr[2] = (byte)(port >> 8);
        addr[3] = (byte)port;
        if (ip is null) return;
        if (ip.AddressFamily == AddressFamily.InterNetwork)
        {
            *(ushort*)addr = 2;
            ip.TryWriteBytes(new Span<byte>(addr + 4, 4), out _);
        }
        else
        {
            *(ushort*)addr = (ushort)(OperatingSystem.IsWindows() ? 23 : OperatingSystem.IsMacOS() ? 30 : 10);
            ip.TryWriteBytes(new Span<byte>(addr + 8, 16), out _);
            *(uint*)(addr + 24) = (uint)ip.ScopeId;
        }
    }
}

internal sealed class QuicNativeException(string what, int status)
    : Exception($"{what} が失敗した (status 0x{status:x})")
{
    public int Status { get; } = status;
}

// ===== msquic.h の構造体 =====

/// <summary>QUIC_API_TABLE。並びを保つため、使わない関数も置く</summary>
[StructLayout(LayoutKind.Sequential)]
internal unsafe struct QuicApiTable
{
    public delegate* unmanaged[Cdecl]<nint, void*, void> SetContext;
    public delegate* unmanaged[Cdecl]<nint, void*> GetContext;
    public delegate* unmanaged[Cdecl]<nint, void*, void*, void> SetCallbackHandler; // 2 番目は関数ポインタ
    public delegate* unmanaged[Cdecl]<nint, uint, uint, void*, int> SetParam;
    public delegate* unmanaged[Cdecl]<nint, uint, uint*, void*, int> GetParam;
    public delegate* unmanaged[Cdecl]<QuicRegistrationConfig*, nint*, int> RegistrationOpen;
    public delegate* unmanaged[Cdecl]<nint, void> RegistrationClose;
    public delegate* unmanaged[Cdecl]<nint, int, ulong, void> RegistrationShutdown;
    public delegate* unmanaged[Cdecl]<nint, QuicBuffer*, uint, QuicSettings*, uint, void*, nint*, int> ConfigurationOpen;
    public delegate* unmanaged[Cdecl]<nint, void> ConfigurationClose;
    public delegate* unmanaged[Cdecl]<nint, QuicCredentialConfig*, int> ConfigurationLoadCredential;
    public delegate* unmanaged[Cdecl]<nint, delegate* unmanaged[Cdecl]<nint, void*, QuicListenerEvent*, int>, void*, nint*, int> ListenerOpen;
    public delegate* unmanaged[Cdecl]<nint, void> ListenerClose;
    public delegate* unmanaged[Cdecl]<nint, QuicBuffer*, uint, void*, int> ListenerStart;
    public delegate* unmanaged[Cdecl]<nint, void> ListenerStop;
    public delegate* unmanaged[Cdecl]<nint, void*, void*, nint*, int> ConnectionOpen;
    public delegate* unmanaged[Cdecl]<nint, void> ConnectionClose;
    public delegate* unmanaged[Cdecl]<nint, int, ulong, void> ConnectionShutdown;
    public delegate* unmanaged[Cdecl]<nint, nint, ushort, byte*, ushort, int> ConnectionStart;
    public delegate* unmanaged[Cdecl]<nint, nint, int> ConnectionSetConfiguration;
    public delegate* unmanaged[Cdecl]<nint, int, ushort, byte*, int> ConnectionSendResumptionTicket;
    public delegate* unmanaged[Cdecl]<nint, int, delegate* unmanaged[Cdecl]<nint, void*, QuicStreamEvent*, int>, void*, nint*, int> StreamOpen;
    public delegate* unmanaged[Cdecl]<nint, void> StreamClose;
    public delegate* unmanaged[Cdecl]<nint, int, int> StreamStart;
    public delegate* unmanaged[Cdecl]<nint, int, ulong, int> StreamShutdown;
    public delegate* unmanaged[Cdecl]<nint, QuicBuffer*, uint, int, void*, int> StreamSend;
    public delegate* unmanaged[Cdecl]<nint, ulong, void> StreamReceiveComplete;
    public delegate* unmanaged[Cdecl]<nint, byte, int> StreamReceiveSetEnabled;
    public delegate* unmanaged[Cdecl]<nint, QuicBuffer*, uint, int, void*, int> DatagramSend;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct QuicBuffer
{
    public uint Length;
    public byte* Buffer;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct QuicRegistrationConfig
{
    public byte* AppName;
    public int ExecutionProfile; // 0 = LOW_LATENCY
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct QuicCertificatePkcs12
{
    public byte* Asn1Blob;
    public uint Asn1BlobLength;
    public byte* PrivateKeyPassword;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct QuicCredentialConfig
{
    public int Type;
    public int Flags;
    public void* Certificate; // union。PKCS12 のときは QuicCertificatePkcs12*
    public byte* Principal;
    public void* Reserved;
    public void* AsyncHandler;
    public int AllowedCipherSuites;
    public byte* CaCertificateFile;
}

/// <summary>QUIC_SETTINGS。IsSetFlags の bit の位置は msquic.h の並び</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct QuicSettings
{
    public ulong IsSetFlags;
    public ulong MaxBytesPerKey;
    public ulong HandshakeIdleTimeoutMs;
    public ulong IdleTimeoutMs;
    public ulong MtuDiscoverySearchCompleteTimeoutUs;
    public uint TlsClientMaxSendBuffer;
    public uint TlsServerMaxSendBuffer;
    public uint StreamRecvWindowDefault;
    public uint StreamRecvBufferDefault;
    public uint ConnFlowControlWindow;
    public uint MaxWorkerQueueDelayUs;
    public uint MaxStatelessOperations;
    public uint InitialWindowPackets;
    public uint SendIdleTimeoutMs;
    public uint InitialRttMs;
    public uint MaxAckDelayMs;
    public uint DisconnectTimeoutMs;
    public uint KeepAliveIntervalMs;
    public ushort CongestionControlAlgorithm;
    public ushort PeerBidiStreamCount;
    public ushort PeerUnidiStreamCount;
    public ushort MaxBindingStatelessOperations;
    public ushort StatelessOperationExpirationMs;
    public ushort MinimumMtu;
    public ushort MaximumMtu;
    public byte Bits; // SendBuffering:1 Pacing:1 Migration:1 DatagramReceive:1 ServerResumption:2 GreaseQuicBit:1 Ecn:1
    public byte MaxOperationsPerDrain;
    public byte MtuDiscoveryMissingProbeCount;
    public uint DestCidUpdateIdleTimeoutMs;
    public ulong Flags;
    public uint StreamRecvWindowBidiLocalDefault;
    public uint StreamRecvWindowBidiRemoteDefault;
    public uint StreamRecvWindowUnidiDefault;

    // IsSetFlags の bit
    public const int IsSetIdleTimeoutMs = 2;
    public const int IsSetKeepAliveIntervalMs = 16;
    public const int IsSetCongestionControlAlgorithm = 17;
    public const int IsSetPeerBidiStreamCount = 18;
    public const int IsSetPeerUnidiStreamCount = 19;
    public const int IsSetDatagramReceiveEnabled = 27;

    public const byte BitDatagramReceive = 1 << 3;

    public void Set(int bit) => IsSetFlags |= 1UL << bit;
}

[StructLayout(LayoutKind.Explicit)]
internal unsafe struct QuicListenerEvent
{
    public const int NewConnection = 0;

    [FieldOffset(0)] public int Type;
    [FieldOffset(8)] public void* NewConnectionInfo;
    [FieldOffset(16)] public nint NewConnectionHandle;
}

[StructLayout(LayoutKind.Explicit)]
internal unsafe struct QuicConnectionEvent
{
    public const int Connected = 0;
    public const int ShutdownInitiatedByTransport = 1;
    public const int ShutdownInitiatedByPeer = 2;
    public const int ShutdownComplete = 3;
    public const int PeerStreamStarted = 6;
    public const int DatagramReceived = 11;
    public const int DatagramSendStateChanged = 12;

    [FieldOffset(0)] public int Type;
    // SHUTDOWN_INITIATED_BY_TRANSPORT
    [FieldOffset(8)] public int TransportStatus;
    [FieldOffset(16)] public ulong TransportErrorCode;
    // SHUTDOWN_INITIATED_BY_PEER
    [FieldOffset(8)] public ulong PeerErrorCode;
    // SHUTDOWN_COMPLETE: HandshakeCompleted:1 PeerAcknowledgedShutdown:1 AppCloseInProgress:1
    [FieldOffset(8)] public byte ShutdownCompleteBits;
    // PEER_STREAM_STARTED
    [FieldOffset(8)] public nint PeerStream;
    [FieldOffset(16)] public int PeerStreamFlags;
    // DATAGRAM_RECEIVED
    [FieldOffset(8)] public QuicBuffer* DatagramBuffer;
    // DATAGRAM_SEND_STATE_CHANGED
    [FieldOffset(8)] public void* DatagramClientContext;
    [FieldOffset(16)] public int DatagramSendState;
}

[StructLayout(LayoutKind.Explicit)]
internal unsafe struct QuicStreamEvent
{
    public const int StartComplete = 0;
    public const int Receive = 1;
    public const int SendComplete = 2;
    public const int PeerSendShutdown = 3;
    public const int PeerSendAborted = 4;
    public const int PeerReceiveAborted = 5;
    public const int SendShutdownComplete = 6;
    public const int ShutdownComplete = 7;

    [FieldOffset(0)] public int Type;
    // START_COMPLETE
    [FieldOffset(8)] public int StartStatus;
    // RECEIVE
    [FieldOffset(16)] public ulong TotalBufferLength;
    [FieldOffset(24)] public QuicBuffer* Buffers;
    [FieldOffset(32)] public uint BufferCount;
    // SEND_COMPLETE
    [FieldOffset(8)] public byte Canceled;
    [FieldOffset(16)] public void* SendClientContext;
    // PEER_SEND_ABORTED / PEER_RECEIVE_ABORTED
    [FieldOffset(8)] public ulong AbortErrorCode;
    // SHUTDOWN_COMPLETE: ConnectionShutdown(BOOLEAN)、その次のバイトに AppCloseInProgress:1 ...
    [FieldOffset(9)] public byte ShutdownCompleteBits;
}

// ===== 扱いやすい包み =====

/// <summary>msquic の registration。プロセスに 1 つ</summary>
internal sealed unsafe class QuicRegistration : IDisposable
{
    public nint Handle { get; private set; }

    public QuicRegistration(string appName)
    {
        MsQuic.Open();
        var name = Utf8z(appName);
        fixed (byte* p = name)
        {
            var reg = new QuicRegistrationConfig { AppName = p, ExecutionProfile = 0 };
            nint h;
            MsQuic.Check(MsQuic.Api->RegistrationOpen(&reg, &h), "RegistrationOpen");
            Handle = h;
        }
    }

    /// <summary>全部の接続を閉じ始める。待たない</summary>
    public void Shutdown()
    {
        if (Handle != 0) MsQuic.Api->RegistrationShutdown(Handle, 0, 0);
    }

    /// <summary>子の接続がすべて閉じるまで待つ。コールバックの中から呼ぶと止まる</summary>
    public void Dispose()
    {
        if (Handle == 0) return;
        MsQuic.Api->RegistrationClose(Handle);
        Handle = 0;
    }

    internal static byte[] Utf8z(string s)
    {
        var b = new byte[System.Text.Encoding.UTF8.GetByteCount(s) + 1];
        System.Text.Encoding.UTF8.GetBytes(s, b);
        return b;
    }
}

/// <summary>
/// 設定と証明書の組(msquic の configuration)。証明書を取り直したら新しく作って差し替える。
/// msquic の中で参照を数えているので、古いものを閉じても、それを使っている接続は続く
/// </summary>
internal sealed unsafe class QuicServerConfig : IDisposable
{
    public nint Handle { get; private set; }

    public QuicServerConfig(QuicRegistration reg, string alpn, in QuicSettings settings, byte[] pkcs12, string? password)
    {
        var alpnBytes = System.Text.Encoding.ASCII.GetBytes(alpn);
        var s = settings;
        fixed (byte* pAlpn = alpnBytes)
        {
            var buf = new QuicBuffer { Length = (uint)alpnBytes.Length, Buffer = pAlpn };
            nint h;
            MsQuic.Check(MsQuic.Api->ConfigurationOpen(reg.Handle, &buf, 1, &s, (uint)sizeof(QuicSettings), null, &h), "ConfigurationOpen");
            Handle = h;
        }
        try
        {
            var pw = password is null ? null : QuicRegistration.Utf8z(password);
            fixed (byte* pBlob = pkcs12)
            fixed (byte* pPw = pw)
            {
                var p12 = new QuicCertificatePkcs12 { Asn1Blob = pBlob, Asn1BlobLength = (uint)pkcs12.Length, PrivateKeyPassword = pPw };
                var cred = new QuicCredentialConfig { Type = MsQuic.CredentialTypePkcs12, Flags = 0, Certificate = &p12 };
                MsQuic.Check(MsQuic.Api->ConfigurationLoadCredential(Handle, &cred), "ConfigurationLoadCredential");
            }
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    /// <summary>msquic が受け入れた設定を読み戻す。BBR が効いたかの確認に使う</summary>
    public QuicSettings ReadBack()
    {
        QuicSettings s;
        uint len = (uint)sizeof(QuicSettings);
        MsQuic.Check(MsQuic.Api->GetParam(Handle, MsQuic.ParamConfigurationSettings, &len, &s), "GetParam(CONFIGURATION_SETTINGS)");
        return s;
    }

    public void Dispose()
    {
        if (Handle == 0) return;
        MsQuic.Api->ConfigurationClose(Handle);
        Handle = 0;
    }
}

/// <summary>UDP の口で接続を待つ。新しい接続は onConnection に渡し、configure で設定と証明書を付ける</summary>
internal sealed unsafe class QuicListener : IDisposable
{
    readonly Func<QuicConnection, int> _configure;
    readonly Func<QuicConnection, bool> _onConnection;
    GCHandle _self;
    nint _handle;

    public QuicListener(QuicRegistration reg, Func<QuicConnection, int> configure, Func<QuicConnection, bool> onConnection)
    {
        _configure = configure;
        _onConnection = onConnection;
        _self = GCHandle.Alloc(this);
        nint h;
        int st = MsQuic.Api->ListenerOpen(reg.Handle, &Callback, (void*)GCHandle.ToIntPtr(_self), &h);
        if (MsQuic.Failed(st)) { _self.Free(); throw new QuicNativeException("ListenerOpen", st); }
        _handle = h;
    }

    /// <summary>ip が null なら全アドレス(IPv4 と IPv6)で待つ</summary>
    public void Start(string alpn, IPAddress? ip, ushort port)
    {
        byte* addr = stackalloc byte[32];
        MsQuic.WriteAddress(addr, ip, port);
        var alpnBytes = System.Text.Encoding.ASCII.GetBytes(alpn);
        fixed (byte* pAlpn = alpnBytes)
        {
            var buf = new QuicBuffer { Length = (uint)alpnBytes.Length, Buffer = pAlpn };
            MsQuic.Check(MsQuic.Api->ListenerStart(_handle, &buf, 1, addr), "ListenerStart");
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static int Callback(nint listener, void* ctx, QuicListenerEvent* ev)
    {
        // 断るときの値。Windows は E_ABORT、Linux は EOPNOTSUPP
        int refuse = OperatingSystem.IsWindows() ? unchecked((int)0x80004004) : 95;
        if (ev->Type != QuicListenerEvent.NewConnection) return MsQuic.StatusSuccess;
        try
        {
            var self = (QuicListener)GCHandle.FromIntPtr((nint)ctx).Target!;
            var conn = new QuicConnection(ev->NewConnectionHandle);
            if (!self._onConnection(conn)) { conn.Release(); return refuse; }
            int st = self._configure(conn);
            if (st == -1 || MsQuic.Failed(st)) { conn.Release(); return refuse; }
            return MsQuic.StatusSuccess;
        }
        catch (Exception)
        {
            return refuse;
        }
    }

    public void Dispose()
    {
        if (_handle != 0)
        {
            // 止まるまで待つ
            MsQuic.Api->ListenerClose(_handle);
            _handle = 0;
        }
        if (_self.IsAllocated) _self.Free();
    }
}

/// <summary>1 本の QUIC 接続。イベントは上の層(HTTP/3)が受け取る</summary>
internal sealed unsafe class QuicConnection
{
    /// <summary>この接続とその stream の状態を守る。コールバックはこれを持って呼ばれる</summary>
    public readonly Lock Gate = new();
    public nint Handle { get; private set; }
    GCHandle _self;
    bool _closed;

    public Action<QuicConnection>? OnConnected;
    public Action<QuicConnection, QuicStream, bool>? OnPeerStream; // bool は単方向か
    public DatagramHandler? OnDatagram;
    public Action<QuicConnection, string>? OnShutdown; // 理由
    public Action<QuicConnection>? OnClosed;

    public delegate void DatagramHandler(QuicConnection c, ReadOnlySpan<byte> data);

    internal QuicConnection(nint handle)
    {
        Handle = handle;
        _self = GCHandle.Alloc(this);
        MsQuic.Api->SetCallbackHandler(handle, (void*)(delegate* unmanaged[Cdecl]<nint, void*, QuicConnectionEvent*, int>)&Callback, (void*)GCHandle.ToIntPtr(_self));
    }

    /// <summary>受け入れずに手放す。listener のコールバックの中だけで使う。handle は msquic が閉じる</summary>
    internal void Release()
    {
        if (_self.IsAllocated) _self.Free();
        Handle = 0;
        _closed = true;
    }

    /// <summary>受けた接続に設定と証明書を付ける。listener のコールバックの中で呼ぶ</summary>
    internal int SetConfiguration(nint configuration) => MsQuic.Api->ConnectionSetConfiguration(Handle, configuration);

    public QuicSettings ReadSettings()
    {
        QuicSettings s;
        uint len = (uint)sizeof(QuicSettings);
        lock (Gate)
        {
            if (_closed) return default;
            MsQuic.Check(MsQuic.Api->GetParam(Handle, MsQuic.ParamConnSettings, &len, &s), "GetParam(CONN_SETTINGS)");
        }
        return s;
    }

    /// <summary>自分から stream を開く</summary>
    public QuicStream OpenStream(bool unidirectional)
    {
        lock (Gate)
        {
            if (_closed) throw new ObjectDisposedException(nameof(QuicConnection));
            var s = new QuicStream(this);
            nint h;
            int st = MsQuic.Api->StreamOpen(Handle, unidirectional ? MsQuic.StreamOpenUnidirectional : 0, &QuicStream.Callback, (void*)s.Context, &h);
            if (MsQuic.Failed(st)) { s.FreeHandle(); throw new QuicNativeException("StreamOpen", st); }
            s.Attach(h);
            st = MsQuic.Api->StreamStart(h, MsQuic.StreamStartImmediate);
            if (MsQuic.Failed(st))
            {
                MsQuic.Api->StreamClose(h);
                s.FreeHandle();
                throw new QuicNativeException("StreamStart", st);
            }
            return s;
        }
    }

    /// <summary>QUIC の datagram を送る。送り終わるまでバッファを保つ</summary>
    public void SendDatagram(ReadOnlySpan<byte> data)
    {
        lock (Gate)
        {
            if (_closed) return;
            var block = SendBlock.Create(data, null);
            int st = MsQuic.Api->DatagramSend(Handle, SendBlock.Buffer(block), 1, 0, (void*)block);
            if (MsQuic.Failed(st)) SendBlock.Complete(block, canceled: true);
        }
    }

    public void Shutdown(ulong errorCode)
    {
        lock (Gate)
        {
            if (!_closed) MsQuic.Api->ConnectionShutdown(Handle, 0, errorCode);
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static int Callback(nint handle, void* ctx, QuicConnectionEvent* ev)
    {
        var self = (QuicConnection)GCHandle.FromIntPtr((nint)ctx).Target!;
        lock (self.Gate)
        {
            try { self.Dispatch(ev); }
            catch (Exception e) { self.OnShutdown?.Invoke(self, $"コールバックで例外: {e.Message}"); }
        }
        return MsQuic.StatusSuccess;
    }

    void Dispatch(QuicConnectionEvent* ev)
    {
        switch (ev->Type)
        {
            case QuicConnectionEvent.Connected:
                OnConnected?.Invoke(this);
                break;
            case QuicConnectionEvent.ShutdownInitiatedByTransport:
                OnShutdown?.Invoke(this, $"transport status=0x{ev->TransportStatus:x} code=0x{ev->TransportErrorCode:x}");
                break;
            case QuicConnectionEvent.ShutdownInitiatedByPeer:
                OnShutdown?.Invoke(this, $"peer code=0x{ev->PeerErrorCode:x}");
                break;
            case QuicConnectionEvent.PeerStreamStarted:
            {
                var s = new QuicStream(this);
                s.Attach(ev->PeerStream);
                MsQuic.Api->SetCallbackHandler(ev->PeerStream, (void*)(delegate* unmanaged[Cdecl]<nint, void*, QuicStreamEvent*, int>)&QuicStream.Callback, (void*)s.Context);
                s.LoadId();
                bool uni = (ev->PeerStreamFlags & MsQuic.StreamOpenUnidirectional) != 0;
                if (OnPeerStream != null) OnPeerStream(this, s, uni);
                else s.Abort(0x100);
                break;
            }
            case QuicConnectionEvent.DatagramReceived:
                OnDatagram?.Invoke(this, new ReadOnlySpan<byte>(ev->DatagramBuffer->Buffer, (int)ev->DatagramBuffer->Length));
                break;
            case QuicConnectionEvent.DatagramSendStateChanged:
                // 3 以上(LOST_DISCARDED、ACKNOWLEDGED、ACKNOWLEDGED_SPURIOUS、CANCELED)で終わり
                if (ev->DatagramSendState >= 3) SendBlock.Complete((nint)ev->DatagramClientContext, canceled: false);
                break;
            case QuicConnectionEvent.ShutdownComplete:
            {
                bool appClose = (ev->ShutdownCompleteBits & 4) != 0;
                _closed = true;
                try { OnClosed?.Invoke(this); }
                finally
                {
                    if (!appClose) MsQuic.Api->ConnectionClose(Handle);
                    if (_self.IsAllocated) _self.Free();
                }
                break;
            }
        }
    }
}

/// <summary>1 本の QUIC stream。受信はコールバックの中で写して返す。溜まりすぎたら受信を止める(SetReceiveEnabled)</summary>
internal sealed unsafe class QuicStream
{
    public QuicConnection Connection { get; }
    public nint Handle { get; private set; }
    public ulong Id { get; private set; }
    GCHandle _self;
    bool _closed;
    bool _idKnown;

    public delegate void ReceiveHandler(QuicStream s, ReadOnlySpan<byte> data, bool fin);
    /// <summary>届いたバイト。fin は相手が送り終えた印(中身は空)</summary>
    public ReceiveHandler? OnReceive;
    /// <summary>相手が送信を打ち切った(RESET_STREAM)</summary>
    public Action<QuicStream, ulong>? OnPeerAbort;
    /// <summary>stream が終わった。このあと handle は使えない</summary>
    public Action<QuicStream>? OnClosed;

    readonly TaskCompletionSource _sendDone = new(TaskCreationOptions.RunContinuationsAsynchronously);
    /// <summary>送信側が終わった。FIN まで相手が受け取ったか、打ち切った</summary>
    public Task SendDone => _sendDone.Task;

    internal QuicStream(QuicConnection c)
    {
        Connection = c;
        _self = GCHandle.Alloc(this);
    }

    internal nint Context => GCHandle.ToIntPtr(_self);
    public bool IsClosed => _closed;

    internal void Attach(nint handle) => Handle = handle;

    internal void FreeHandle()
    {
        if (_self.IsAllocated) _self.Free();
        _closed = true;
        _sendDone.TrySetResult();
    }

    /// <summary>送る。送り終わりを待たない。fin で送信側を閉じる</summary>
    public void Send(ReadOnlySpan<byte> data, bool fin = false)
    {
        lock (Connection.Gate)
        {
            if (_closed) return;
            var block = SendBlock.Create(data, null);
            int st = MsQuic.Api->StreamSend(Handle, SendBlock.Buffer(block), 1, fin ? MsQuic.SendFlagFin : 0, (void*)block);
            if (MsQuic.Failed(st)) { SendBlock.Complete(block, canceled: true); throw new QuicNativeException("StreamSend", st); }
        }
    }

    /// <summary>
    /// 送って、msquic がバッファを返すまで待つ。msquic は送り先の窓が空くまでバッファを抱えるので、
    /// これを待てば送る側が溜め込みすぎない
    /// </summary>
    public Task SendAsync(ReadOnlySpan<byte> data, bool fin = false)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (Connection.Gate)
        {
            if (_closed) return Task.FromException(new IOException("stream が閉じている"));
            var block = SendBlock.Create(data, tcs);
            int st = MsQuic.Api->StreamSend(Handle, SendBlock.Buffer(block), 1, fin ? MsQuic.SendFlagFin : 0, (void*)block);
            if (MsQuic.Failed(st))
            {
                SendBlock.Complete(block, canceled: true);
                return Task.FromException(new QuicNativeException("StreamSend", st));
            }
        }
        return tcs.Task;
    }

    /// <summary>送信側を正しく閉じる(FIN)</summary>
    public void Finish()
    {
        lock (Connection.Gate)
        {
            if (!_closed) MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownGraceful, 0);
        }
    }

    /// <summary>両方向を打ち切る(RESET_STREAM と STOP_SENDING)</summary>
    public void Abort(ulong errorCode)
    {
        lock (Connection.Gate)
        {
            if (!_closed) MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownAbort, errorCode);
        }
    }

    /// <summary>受信側だけ打ち切る(STOP_SENDING)</summary>
    public void StopReceiving(ulong errorCode)
    {
        lock (Connection.Gate)
        {
            if (!_closed) MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownAbortReceive, errorCode);
        }
    }

    /// <summary>受信を止める・戻す。止めているあいだ msquic は窓を広げないので、相手が送れなくなる</summary>
    public void SetReceiveEnabled(bool enabled)
    {
        lock (Connection.Gate)
        {
            if (!_closed) MsQuic.Api->StreamReceiveSetEnabled(Handle, enabled ? (byte)1 : (byte)0);
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    internal static int Callback(nint handle, void* ctx, QuicStreamEvent* ev)
    {
        var self = (QuicStream)GCHandle.FromIntPtr((nint)ctx).Target!;
        lock (self.Connection.Gate)
        {
            try { self.Dispatch(ev); }
            catch (Exception)
            {
                // 上の層の誤り。stream を打ち切って続ける(H3_INTERNAL_ERROR)
                if (ev->Type != QuicStreamEvent.ShutdownComplete && !self._closed)
                    MsQuic.Api->StreamShutdown(self.Handle, MsQuic.StreamShutdownAbort, 0x102);
            }
        }
        return MsQuic.StatusSuccess;
    }

    void Dispatch(QuicStreamEvent* ev)
    {
        switch (ev->Type)
        {
            case QuicStreamEvent.StartComplete:
                if (!MsQuic.Failed(ev->StartStatus)) LoadId();
                break;
            case QuicStreamEvent.Receive:
            {
                LoadId();
                uint n = ev->BufferCount;
                if (n == 1)
                {
                    OnReceive?.Invoke(this, new ReadOnlySpan<byte>(ev->Buffers[0].Buffer, (int)ev->Buffers[0].Length), false);
                }
                else if (n > 1)
                {
                    var all = new byte[ev->TotalBufferLength];
                    int off = 0;
                    for (int i = 0; i < n; i++)
                    {
                        new ReadOnlySpan<byte>(ev->Buffers[i].Buffer, (int)ev->Buffers[i].Length).CopyTo(all.AsSpan(off));
                        off += (int)ev->Buffers[i].Length;
                    }
                    OnReceive?.Invoke(this, all, false);
                }
                break;
            }
            case QuicStreamEvent.SendComplete:
                SendBlock.Complete((nint)ev->SendClientContext, ev->Canceled != 0);
                break;
            case QuicStreamEvent.PeerSendShutdown:
                OnReceive?.Invoke(this, default, true);
                break;
            case QuicStreamEvent.PeerSendAborted:
                OnPeerAbort?.Invoke(this, ev->AbortErrorCode);
                break;
            case QuicStreamEvent.SendShutdownComplete:
                _sendDone.TrySetResult();
                break;
            case QuicStreamEvent.ShutdownComplete:
            {
                _closed = true;
                _sendDone.TrySetResult();
                bool appClose = (ev->ShutdownCompleteBits & 1) != 0;
                try { OnClosed?.Invoke(this); }
                finally
                {
                    if (!appClose) MsQuic.Api->StreamClose(Handle);
                    if (_self.IsAllocated) _self.Free();
                }
                break;
            }
        }
    }

    /// <summary>ID を読む。自分で開いた stream は始まるまで ID が決まらない</summary>
    internal void LoadId()
    {
        if (_idKnown || Handle == 0) return;
        ulong id;
        uint len = 8;
        if (MsQuic.Failed(MsQuic.Api->GetParam(Handle, MsQuic.ParamStreamId, &len, &id))) return;
        Id = id;
        _idKnown = true;
    }
}

/// <summary>
/// 送信中のバッファ。[QUIC_BUFFER][待ち手の GCHandle][データ] を 1 つの塊にして、ClientSendContext に渡す。
/// msquic が SEND_COMPLETE で返してきたら、待ち手に知らせて解放する
/// </summary>
internal static unsafe class SendBlock
{
    static readonly int Header = sizeof(QuicBuffer) + sizeof(nint);

    public static nint Create(ReadOnlySpan<byte> data, TaskCompletionSource? waiter)
    {
        var p = (byte*)NativeMemory.Alloc((nuint)(Header + data.Length));
        var b = (QuicBuffer*)p;
        b->Length = (uint)data.Length;
        b->Buffer = p + Header;
        *(nint*)(p + sizeof(QuicBuffer)) = waiter is null ? 0 : GCHandle.ToIntPtr(GCHandle.Alloc(waiter));
        data.CopyTo(new Span<byte>(b->Buffer, data.Length));
        return (nint)p;
    }

    public static QuicBuffer* Buffer(nint block) => (QuicBuffer*)block;

    public static void Complete(nint block, bool canceled)
    {
        if (block == 0) return;
        var h = *(nint*)((byte*)block + sizeof(QuicBuffer));
        NativeMemory.Free((void*)block);
        if (h == 0) return;
        var handle = GCHandle.FromIntPtr(h);
        var tcs = (TaskCompletionSource)handle.Target!;
        handle.Free();
        if (canceled) tcs.TrySetException(new IOException("送信が取り消された"));
        else tcs.TrySetResult();
    }
}
