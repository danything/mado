// msquic を P/Invoke で直接呼ぶ層。
// System.Net.Quic は QUIC の datagram を宣言できず、輻輳制御も選べない。そのため msquic の API 表を自分で引く。
// 構造体の並びは msquic 2.6 の msquic.h に合わせる(x64 / arm64 の 64 bit だけを考える)。
// msquic はコールバックを自分のスレッドから呼ぶ。1 つの接続とその stream のコールバックは同じスレッドで順に呼ばれる。
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Mado.WebTransport;

/// <summary>msquic の関数表と定数。</summary>
internal static unsafe class MsQuic
{
    public const int StatusSuccess = 0;

    // 型の値は msquic.h の enum の順。
    public const uint ParamConfigurationSettings = 0x03000000;
    public const uint ParamConnSettings = 0x05000004;
    public const uint ParamConnStatisticsV2 = 0x05000016;
    public const uint ParamStreamId = 0x08000000;
    public const uint ParamGlobalLibraryVersion = 0x01000004;

    public const ushort CongestionCubic = 0;
    public const ushort CongestionBbr = 1;

    public const int CredentialTypePkcs12 = 6;

    public const int StreamOpenUnidirectional = 1;
    public const int StreamStartImmediate = 1;
    public const int StreamShutdownGraceful = 1;
    public const int StreamShutdownAbortSend = 2;
    public const int StreamShutdownAbortReceive = 4;
    public const int StreamShutdownAbort = 6;
    public const int SendFlagFin = 4;

    public static QuicApiTable* Api;
    static nint _lib;

    /// <summary>Windows では msquic.dll、Linux では libmsquic.so.2 を読む。</summary>
    public static void Open()
    {
        if (Api != null) return;
        string[] names = OperatingSystem.IsWindows()
            ? [Path.Combine(AppContext.BaseDirectory, "msquic.dll"),
               Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "msquic.dll"),
               "msquic.dll"]
            : OperatingSystem.IsMacOS()
                ? ["libmsquic.dylib"]
                : ["libmsquic.so.2", "libmsquic.so"];
        foreach (var n in names)
            if (NativeLibrary.TryLoad(n, out _lib)) break;
        if (_lib == 0) throw new DllNotFoundException("msquic が見つからない: " + string.Join(", ", names));

        var open = (delegate* unmanaged[Cdecl]<uint, QuicApiTable**, int>)NativeLibrary.GetExport(_lib, "MsQuicOpenVersion");
        QuicApiTable* api;
        Check(open(2, &api), "MsQuicOpenVersion");
        Api = api;
    }

    /// <summary>msquic の版。2.2 より前は BBR が無い。</summary>
    public static string Version()
    {
        uint* v = stackalloc uint[4];
        uint len = 16;
        if (Failed(Api->GetParam(0, ParamGlobalLibraryVersion, &len, v))) return "?";
        return $"{v[0]}.{v[1]}.{v[2]}";
    }

    /// <summary>失敗の判定。Windows は HRESULT(負が失敗)、Linux は errno(正が失敗)。</summary>
    public static bool Failed(int status) => OperatingSystem.IsWindows() ? status < 0 : status > 0;

    public static void Check(int status, string what)
    {
        if (Failed(status)) throw new QuicNativeException(what, status);
    }

    /// <summary>stream の ID。QUIC の stream ID そのもの。</summary>
    public static ulong StreamId(nint stream)
    {
        ulong id;
        uint len = 8;
        Check(Api->GetParam(stream, ParamStreamId, &len, &id), "GetParam(STREAM_ID)");
        return id;
    }
}

public sealed class QuicNativeException(string what, int status)
    : Exception($"{what} が失敗した (status 0x{status:x})")
{
    public int Status { get; } = status;
}

// ===== msquic.h の構造体 =====

/// <summary>QUIC_API_TABLE。使う関数だけでなく並びを保つためにすべて置く。</summary>
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
    public delegate* unmanaged[Cdecl]<nint, byte, int> ConnectionResumptionTicketValidationComplete;
    public delegate* unmanaged[Cdecl]<nint, byte, int, int> ConnectionCertificateValidationComplete;
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

/// <summary>QUIC_SETTINGS。IsSetFlags の bit 位置は msquic.h の並び。</summary>
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
}

[StructLayout(LayoutKind.Explicit)]
internal unsafe struct QuicListenerEvent
{
    public const int NewConnection = 0;
    public const int StopComplete = 1;

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
    public const int DatagramStateChanged = 10;
    public const int DatagramReceived = 11;
    public const int DatagramSendStateChanged = 12;

    [FieldOffset(0)] public int Type;
    // CONNECTED
    [FieldOffset(8)] public byte SessionResumed;
    [FieldOffset(9)] public byte NegotiatedAlpnLength;
    [FieldOffset(16)] public byte* NegotiatedAlpn;
    // SHUTDOWN_INITIATED_BY_TRANSPORT: Status, ErrorCode
    [FieldOffset(8)] public int TransportStatus;
    [FieldOffset(16)] public ulong TransportErrorCode;
    // SHUTDOWN_INITIATED_BY_PEER
    [FieldOffset(8)] public ulong PeerErrorCode;
    // SHUTDOWN_COMPLETE: HandshakeCompleted:1 PeerAcknowledgedShutdown:1 AppCloseInProgress:1
    [FieldOffset(8)] public byte ShutdownCompleteBits;
    // PEER_STREAM_STARTED
    [FieldOffset(8)] public nint PeerStream;
    [FieldOffset(16)] public int PeerStreamFlags;
    // DATAGRAM_STATE_CHANGED
    [FieldOffset(8)] public byte DatagramSendEnabled;
    [FieldOffset(10)] public ushort DatagramMaxSendLength;
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
    [FieldOffset(8)] public ulong AbsoluteOffset;
    [FieldOffset(16)] public ulong TotalBufferLength;
    [FieldOffset(24)] public QuicBuffer* Buffers;
    [FieldOffset(32)] public uint BufferCount;
    [FieldOffset(36)] public int ReceiveFlags;
    // SEND_COMPLETE
    [FieldOffset(8)] public byte Canceled;
    [FieldOffset(16)] public void* SendClientContext;
    // PEER_SEND_ABORTED / PEER_RECEIVE_ABORTED
    [FieldOffset(8)] public ulong AbortErrorCode;
    // SHUTDOWN_COMPLETE
    [FieldOffset(8)] public byte ConnectionShutdown;
    [FieldOffset(9)] public byte ShutdownCompleteBits; // AppCloseInProgress:1 ...
}

// ===== 扱いやすい包み =====

/// <summary>サーバーの設定と証明書。ALPN は 1 つだけ持つ。</summary>
internal sealed unsafe class QuicServerConfig : IDisposable
{
    public nint Registration { get; private set; }
    public nint Configuration { get; private set; }

    public QuicServerConfig(string appName, string alpn, in QuicSettings settings, byte[] pkcs12, string password)
    {
        MsQuic.Open();
        var name = Utf8z(appName);
        fixed (byte* pName = name)
        {
            var reg = new QuicRegistrationConfig { AppName = pName, ExecutionProfile = 0 };
            nint h;
            MsQuic.Check(MsQuic.Api->RegistrationOpen(&reg, &h), "RegistrationOpen");
            Registration = h;
        }

        var alpnBytes = System.Text.Encoding.ASCII.GetBytes(alpn);
        var s = settings;
        fixed (byte* pAlpn = alpnBytes)
        {
            var buf = new QuicBuffer { Length = (uint)alpnBytes.Length, Buffer = pAlpn };
            nint h;
            MsQuic.Check(MsQuic.Api->ConfigurationOpen(Registration, &buf, 1, &s, (uint)sizeof(QuicSettings), null, &h), "ConfigurationOpen");
            Configuration = h;
        }

        var pw = Utf8z(password);
        fixed (byte* pBlob = pkcs12)
        fixed (byte* pPw = pw)
        {
            var p12 = new QuicCertificatePkcs12 { Asn1Blob = pBlob, Asn1BlobLength = (uint)pkcs12.Length, PrivateKeyPassword = pPw };
            var cred = new QuicCredentialConfig { Type = MsQuic.CredentialTypePkcs12, Flags = 0, Certificate = &p12 };
            MsQuic.Check(MsQuic.Api->ConfigurationLoadCredential(Configuration, &cred), "ConfigurationLoadCredential");
        }
    }

    /// <summary>msquic が受け入れた設定を読み戻す。BBR が効いたかの確認に使う。</summary>
    public QuicSettings ReadBack()
    {
        QuicSettings s;
        uint len = (uint)sizeof(QuicSettings);
        MsQuic.Check(MsQuic.Api->GetParam(Configuration, MsQuic.ParamConfigurationSettings, &len, &s), "GetParam(CONFIGURATION_SETTINGS)");
        return s;
    }

    public void Dispose()
    {
        if (Configuration != 0) { MsQuic.Api->ConfigurationClose(Configuration); Configuration = 0; }
        // 子の接続がすべて閉じるまで待つ。コールバックの中から呼ぶと止まる
        if (Registration != 0) { MsQuic.Api->RegistrationClose(Registration); Registration = 0; }
    }

    internal static byte[] Utf8z(string s)
    {
        var b = new byte[System.Text.Encoding.UTF8.GetByteCount(s) + 1];
        System.Text.Encoding.UTF8.GetBytes(s, b);
        return b;
    }
}

/// <summary>UDP の口で接続を待つ。新しい接続は OnConnection に渡す。</summary>
internal sealed unsafe class QuicListener : IDisposable
{
    readonly QuicServerConfig _config;
    readonly Func<QuicConnection, bool> _onConnection;
    GCHandle _self;
    nint _handle;

    public QuicListener(QuicServerConfig config, Func<QuicConnection, bool> onConnection)
    {
        _config = config;
        _onConnection = onConnection;
        _self = GCHandle.Alloc(this);
        nint h;
        MsQuic.Check(MsQuic.Api->ListenerOpen(config.Registration, &Callback, (void*)GCHandle.ToIntPtr(_self), &h), "ListenerOpen");
        _handle = h;
    }

    /// <summary>全アドレスの port で待つ。IPv4 と IPv6 の両方を受ける。</summary>
    public void Start(string alpn, ushort port)
    {
        // QUIC_ADDR は sockaddr_in6 と同じ 28 バイト。family 0 は AF_UNSPEC で、両方を待つ
        byte* addr = stackalloc byte[32];
        new Span<byte>(addr, 32).Clear();
        addr[2] = (byte)(port >> 8);
        addr[3] = (byte)port;
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
        var self = (QuicListener)GCHandle.FromIntPtr((nint)ctx).Target!;
        if (ev->Type != QuicListenerEvent.NewConnection) return MsQuic.StatusSuccess;
        try
        {
            var conn = new QuicConnection(ev->NewConnectionHandle);
            if (!self._onConnection(conn))
            {
                conn.Release();
                return OperatingSystem.IsWindows() ? unchecked((int)0x80004004) : 95; // 断る
            }
            int st = MsQuic.Api->ConnectionSetConfiguration(conn.Handle, self._config.Configuration);
            if (MsQuic.Failed(st)) { conn.Release(); return st; }
            return MsQuic.StatusSuccess;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"listener: {e}");
            return OperatingSystem.IsWindows() ? unchecked((int)0x80004005) : 5;
        }
    }

    public void Dispose()
    {
        if (_handle != 0)
        {
            // ListenerClose は止まるまで待つ
            MsQuic.Api->ListenerClose(_handle);
            _handle = 0;
        }
        if (_self.IsAllocated) _self.Free();
    }
}

/// <summary>1 本の QUIC 接続。イベントは上の層(HTTP/3)が受け取る。</summary>
internal sealed unsafe class QuicConnection
{
    public nint Handle { get; private set; }
    GCHandle _self;

    public Action<QuicConnection>? OnConnected;
    public Action<QuicConnection, QuicStream, bool>? OnPeerStream; // bool は単方向か
    public DatagramHandler? OnDatagram;
    public Action<QuicConnection, string>? OnShutdown; // 理由
    public Action<QuicConnection>? OnClosed;

    public delegate void DatagramHandler(QuicConnection c, ReadOnlySpan<byte> data);

    public bool DatagramSendEnabled { get; private set; }
    public int DatagramMaxSendLength { get; private set; }

    internal QuicConnection(nint handle)
    {
        Handle = handle;
        _self = GCHandle.Alloc(this);
        MsQuic.Api->SetCallbackHandler(handle, (void*)(delegate* unmanaged[Cdecl]<nint, void*, QuicConnectionEvent*, int>)&Callback, (void*)GCHandle.ToIntPtr(_self));
    }

    /// <summary>受け入れずに手放す。listener のコールバックの中だけで使う。</summary>
    internal void Release()
    {
        if (_self.IsAllocated) _self.Free();
        Handle = 0;
    }

    public QuicSettings ReadSettings()
    {
        QuicSettings s;
        uint len = (uint)sizeof(QuicSettings);
        MsQuic.Check(MsQuic.Api->GetParam(Handle, MsQuic.ParamConnSettings, &len, &s), "GetParam(CONN_SETTINGS)");
        return s;
    }

    /// <summary>自分から stream を開く。</summary>
    public QuicStream OpenStream(bool unidirectional)
    {
        var s = new QuicStream(this);
        nint h;
        int st = MsQuic.Api->StreamOpen(Handle, unidirectional ? MsQuic.StreamOpenUnidirectional : 0, &QuicStream.Callback, (void*)s.Context, &h);
        if (MsQuic.Failed(st)) { s.FreeHandle(); throw new QuicNativeException("StreamOpen", st); }
        s.Attach(h);
        MsQuic.Check(MsQuic.Api->StreamStart(h, MsQuic.StreamStartImmediate), "StreamStart");
        return s;
    }

    /// <summary>QUIC の datagram を送る。送り終わるまでバッファを保つ。</summary>
    public void SendDatagram(ReadOnlySpan<byte> data)
    {
        var block = SendBlock.Create(data);
        int st = MsQuic.Api->DatagramSend(Handle, (QuicBuffer*)block, 1, 0, (void*)block);
        if (MsQuic.Failed(st)) { SendBlock.Free(block); throw new QuicNativeException("DatagramSend", st); }
    }

    public void Shutdown(ulong errorCode) => MsQuic.Api->ConnectionShutdown(Handle, 0, errorCode);

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    static int Callback(nint handle, void* ctx, QuicConnectionEvent* ev)
    {
        var self = (QuicConnection)GCHandle.FromIntPtr((nint)ctx).Target!;
        try { self.Handle_(ev); }
        catch (Exception e) { Console.Error.WriteLine($"connection: {e}"); }
        return MsQuic.StatusSuccess;
    }

    void Handle_(QuicConnectionEvent* ev)
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
            case QuicConnectionEvent.DatagramStateChanged:
                DatagramSendEnabled = ev->DatagramSendEnabled != 0;
                DatagramMaxSendLength = ev->DatagramMaxSendLength;
                break;
            case QuicConnectionEvent.DatagramReceived:
                OnDatagram?.Invoke(this, new ReadOnlySpan<byte>(ev->DatagramBuffer->Buffer, (int)ev->DatagramBuffer->Length));
                break;
            case QuicConnectionEvent.DatagramSendStateChanged:
                // 3 以上(LOST_DISCARDED, ACKNOWLEDGED, ..., CANCELED)で終わり
                if (ev->DatagramSendState >= 3) SendBlock.Free((nint)ev->DatagramClientContext);
                break;
            case QuicConnectionEvent.ShutdownComplete:
            {
                bool appClose = (ev->ShutdownCompleteBits & 4) != 0;
                OnClosed?.Invoke(this);
                if (!appClose) MsQuic.Api->ConnectionClose(Handle);
                if (_self.IsAllocated) _self.Free();
                break;
            }
        }
    }
}

/// <summary>1 本の QUIC stream。受信はコールバックの中で写して返す(受信を保留しない)。</summary>
internal sealed unsafe class QuicStream
{
    public QuicConnection Connection { get; }
    public nint Handle { get; private set; }
    public ulong Id { get; private set; }
    GCHandle _self;
    bool _closed;
    bool _idKnown;

    public delegate void ReceiveHandler(QuicStream s, ReadOnlySpan<byte> data, bool fin);
    public ReceiveHandler? OnReceive;
    public Action<QuicStream, ulong>? OnPeerAbort; // 相手が送信を止めた(RESET_STREAM)
    public Action<QuicStream, ulong>? OnPeerStopSending;
    public Action<QuicStream>? OnClosed;

    internal QuicStream(QuicConnection c)
    {
        Connection = c;
        _self = GCHandle.Alloc(this);
    }

    internal nint Context => GCHandle.ToIntPtr(_self);

    internal void Attach(nint handle)
    {
        Handle = handle;
    }

    internal void FreeHandle()
    {
        if (_self.IsAllocated) _self.Free();
    }

    /// <summary>送る。fin で送信側を閉じる。空で fin だけも送れる。</summary>
    public void Send(ReadOnlySpan<byte> data, bool fin = false)
    {
        if (_closed) return;
        var block = SendBlock.Create(data);
        int st = MsQuic.Api->StreamSend(Handle, (QuicBuffer*)block, 1, fin ? MsQuic.SendFlagFin : 0, (void*)block);
        if (MsQuic.Failed(st)) { SendBlock.Free(block); throw new QuicNativeException("StreamSend", st); }
    }

    /// <summary>送信側を正しく閉じる(FIN)。</summary>
    public void Finish()
    {
        if (_closed) return;
        MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownGraceful, 0);
    }

    /// <summary>両方向を打ち切る(RESET_STREAM と STOP_SENDING)。</summary>
    public void Abort(ulong errorCode)
    {
        if (_closed) return;
        MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownAbort, errorCode);
    }

    /// <summary>受信側だけ打ち切る(STOP_SENDING)。</summary>
    public void StopReceiving(ulong errorCode)
    {
        if (_closed) return;
        MsQuic.Api->StreamShutdown(Handle, MsQuic.StreamShutdownAbortReceive, errorCode);
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    internal static int Callback(nint handle, void* ctx, QuicStreamEvent* ev)
    {
        var self = (QuicStream)GCHandle.FromIntPtr((nint)ctx).Target!;
        try { self.Handle_(ev); }
        catch (Exception e) { Console.Error.WriteLine($"stream {self.Id}: {e}"); }
        return MsQuic.StatusSuccess;
    }

    void Handle_(QuicStreamEvent* ev)
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
                SendBlock.Free((nint)ev->SendClientContext);
                break;
            case QuicStreamEvent.PeerSendShutdown:
                OnReceive?.Invoke(this, default, true);
                break;
            case QuicStreamEvent.PeerSendAborted:
                OnPeerAbort?.Invoke(this, ev->AbortErrorCode);
                break;
            case QuicStreamEvent.PeerReceiveAborted:
                OnPeerStopSending?.Invoke(this, ev->AbortErrorCode);
                break;
            case QuicStreamEvent.ShutdownComplete:
            {
                _closed = true;
                OnClosed?.Invoke(this);
                bool appClose = (ev->ShutdownCompleteBits & 1) != 0;
                if (!appClose) MsQuic.Api->StreamClose(Handle);
                if (_self.IsAllocated) _self.Free();
                break;
            }
        }
    }

    /// <summary>ID を読む。自分で開いた stream は始まるまで ID が決まらない。</summary>
    internal void LoadId()
    {
        if (_idKnown || Handle == 0) return;
        Id = MsQuic.StreamId(Handle);
        _idKnown = true;
    }
}

/// <summary>送信中のバッファ。QUIC_BUFFER の後ろにデータを置いた 1 つの塊にする。</summary>
internal static unsafe class SendBlock
{
    public static nint Create(ReadOnlySpan<byte> data)
    {
        var p = (byte*)NativeMemory.Alloc((nuint)(sizeof(QuicBuffer) + data.Length));
        var b = (QuicBuffer*)p;
        b->Length = (uint)data.Length;
        b->Buffer = p + sizeof(QuicBuffer);
        data.CopyTo(new Span<byte>(b->Buffer, data.Length));
        return (nint)p;
    }

    public static void Free(nint p)
    {
        if (p != 0) NativeMemory.Free((void*)p);
    }
}
