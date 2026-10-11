// mado.ico を作る(画面のロゴと同じ「窓」の形。暗い角丸の四角に白い線)。依存なしで ICO(32 bit の DIB)を書く。
//   dotnet run tray/make-icon.cs tray/mado.ico
// 線は少しぼかして(縁を 1 ピクセルで透明度を変えて)小さい大きさでもつぶれにくくする。

var output = args.Length > 0 ? args[0] : "mado.ico";
int[] sizes = [16, 20, 24, 32, 48, 64, 256];
var images = sizes.Select(s => (Size: s, Data: Dib(s))).ToList();

using var file = File.Create(output);
using var w = new BinaryWriter(file);
w.Write((short)0);
w.Write((short)1);
w.Write((short)images.Count);
var offset = 6 + 16 * images.Count;
foreach (var (s, data) in images)
{
    w.Write((byte)(s >= 256 ? 0 : s));
    w.Write((byte)(s >= 256 ? 0 : s));
    w.Write((byte)0);
    w.Write((byte)0);
    w.Write((short)1);
    w.Write((short)32);
    w.Write(data.Length);
    w.Write(offset);
    offset += data.Length;
}
foreach (var (_, data) in images) w.Write(data);

static byte[] Dib(int s)
{
    var px = new byte[s * s * 4];
    double r = s * 0.22, stroke = Math.Max(1.0, s / 14.0);
    double l = 0.22 * s, rr = 0.78 * s, t = 0.24 * s, b = 0.68 * s, mid = (t + b) / 2, cx0 = s / 2.0;
    (double, double, double, double)[] segs =
    [
        (l, t, rr, t), (rr, t, rr, b), (rr, b, l, b), (l, b, l, t),
        (l, mid, rr, mid), (cx0, t, cx0, b), (0.36 * s, 0.82 * s, 0.64 * s, 0.82 * s),
    ];
    for (var y = 0; y < s; y++)
    for (var x = 0; x < s; x++)
    {
        double cx = x + 0.5, cy = y + 0.5;
        // 角丸の四角の内側か(内側の四角 [r, s-r] からの距離が r 以内)
        var qx = Math.Max(0, Math.Max(r - cx, cx - (s - r)));
        var qy = Math.Max(0, Math.Max(r - cy, cy - (s - r)));
        var edge = r - Math.Sqrt(qx * qx + qy * qy);
        if (edge <= -0.5) continue;
        var a = Math.Clamp(edge + 0.5, 0, 1);
        var d = segs.Min(g => Dist(cx, cy, g));
        var white = Math.Clamp(stroke / 2 - d + 0.5, 0, 1);
        var i = ((s - 1 - y) * s + x) * 4; // 下の行から
        px[i] = (byte)(24 + (250 - 24) * white); // B
        px[i + 1] = (byte)(24 + (250 - 24) * white); // G
        px[i + 2] = (byte)(27 + (250 - 27) * white); // R
        px[i + 3] = (byte)(255 * a);
    }
    var mask = new byte[(s + 31) / 32 * 4 * s];
    using var ms = new MemoryStream();
    using var w = new BinaryWriter(ms);
    w.Write(40); w.Write(s); w.Write(s * 2); w.Write((short)1); w.Write((short)32);
    w.Write(0); w.Write(px.Length + mask.Length); w.Write(0); w.Write(0); w.Write(0); w.Write(0);
    w.Write(px);
    w.Write(mask);
    return ms.ToArray();
}

static double Dist(double x, double y, (double X1, double Y1, double X2, double Y2) g)
{
    double dx = g.X2 - g.X1, dy = g.Y2 - g.Y1, l2 = dx * dx + dy * dy;
    var t = l2 == 0 ? 0 : Math.Clamp(((x - g.X1) * dx + (y - g.Y1) * dy) / l2, 0, 1);
    double px = g.X1 + t * dx - x, py = g.Y1 + t * dy - y;
    return Math.Sqrt(px * px + py * py);
}
