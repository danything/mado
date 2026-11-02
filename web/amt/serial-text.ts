// SOL のバイト列を端末に渡す文字列にする。
// BIOS(POST や設定の画面)は罫線などを CP437 の 0x80 以上で送り、Linux は UTF-8 で送る。どちらが来るかは分からないので、
// 3〜4 バイトの UTF-8 として正しく読める並びは UTF-8 に、ほかのバイトは CP437 として読む(Intel の UI Toolkit は全部 CP437 にしている)。
// CP437 の罫線が 3 バイトの UTF-8 の正しい並びに見えることは、まれにある(先頭がギリシャ文字の 0xE0〜0xEF で、続く 2 つが 0x80〜0xBF)。

/** CP437 の 0x80〜0xFF */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

export const cp437 = (b: number): string => CP437_HIGH[b - 0x80] ?? "�";

/**
 * UTF-8 として読む並びの先頭のバイトなら、並び全体の長さ。違えば 0。
 * 2 バイトの並び(先頭 0xC2〜0xDF、続き 0x80〜0xBF)は読まない。CP437 の罫線(0xB0〜0xDF)どうしがちょうどこの形になり、
 * ─┐(0xC4 0xBF)が「Ŀ」に化けるため。2 バイトの字(ü などのアクセント付きの字)は CP437 として出るが、SOL では まれ
 */
function utf8Length(b: number): number {
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

const isContinuation = (b: number) => b >= 0x80 && b <= 0xbf;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** 受け取るたびに decode する。UTF-8 の並びが塊の境目で切れたら、続きが来るまで持っておく */
export class SerialText {
  private pending = new Uint8Array(0);

  /** 持っているバイトがあるか(しばらく続きが来なければ flush する) */
  get waiting(): boolean {
    return this.pending.length > 0;
  }

  decode(chunk: Uint8Array): string {
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.length);
    this.pending = new Uint8Array(0);
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i] as number;
      if (b < 0x80) {
        out += String.fromCharCode(b);
        i++;
        continue;
      }
      const n = utf8Length(b);
      if (n === 0) {
        out += cp437(b);
        i++;
        continue;
      }
      const end = Math.min(i + n, bytes.length);
      let ok = true;
      for (let j = i + 1; j < end; j++)
        if (!isContinuation(bytes[j] as number)) ok = false;
      if (ok && end < i + n) {
        // ここまでは正しい。続きを待つ
        this.pending = bytes.slice(i);
        break;
      }
      if (ok) {
        try {
          out += utf8.decode(bytes.subarray(i, i + n));
          i += n;
          continue;
        } catch {
          // 長すぎる符号やサロゲートなど。CP437 として読む
        }
      }
      out += cp437(b);
      i++;
    }
    return out;
  }

  /** 続きを待っていたバイトを CP437 として出す */
  flush(): string {
    const rest = this.pending;
    this.pending = new Uint8Array(0);
    let out = "";
    for (const b of rest) out += b < 0x80 ? String.fromCharCode(b) : cp437(b);
    return out;
  }
}
