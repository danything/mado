// Intel AMT の WS-Management(SOAP 1.2)。電源の状態を読み、電源を操作する。
// 封筒は DMTF の WS-Man と、Intel の AMT SDK の CIM_PowerManagementService の形に従う。
// 返事の XML は、使う要素を名前で拾うだけにする(DOMParser の無い試験でも動かすため)。

export const NS = {
  soap: "http://www.w3.org/2003/05/soap-envelope",
  addressing: "http://schemas.xmlsoap.org/ws/2004/08/addressing",
  wsman: "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd",
  enumeration: "http://schemas.xmlsoap.org/ws/2004/09/enumeration",
};
const CIM = "http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/";
const ANONYMOUS = `${NS.addressing}/role/anonymous`;

export const RESOURCE = {
  associatedPower: `${CIM}CIM_AssociatedPowerManagementService`,
  powerService: `${CIM}CIM_PowerManagementService`,
  computerSystem: `${CIM}CIM_ComputerSystem`,
};

const ACTION = {
  enumerate: "http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate",
  pull: "http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull",
  powerChange: `${RESOURCE.powerService}/RequestPowerStateChange`,
};

export const escapeXml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c] as string,
  );

const unescapeXml = (s: string): string =>
  s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_, e: string) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e] as string,
  );

const selectorSet = (selectors: Record<string, string>): string =>
  `<w:SelectorSet>${Object.entries(selectors)
    .map(
      ([k, v]) =>
        `<w:Selector Name="${escapeXml(k)}">${escapeXml(v)}</w:Selector>`,
    )
    .join("")}</w:SelectorSet>`;

let messageId = 0;
const nextMessageId = () =>
  typeof crypto.randomUUID === "function"
    ? `uuid:${crypto.randomUUID()}`
    : String(++messageId);

/** SOAP の封筒。宛先(a:To)は AMT の /wsman */
export function envelope(p: {
  action: string;
  resourceUri: string;
  body: string;
  selectors?: Record<string, string>;
  messageId?: string;
}): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:a="${NS.addressing}" xmlns:w="${NS.wsman}">` +
    `<s:Header>` +
    `<a:Action s:mustUnderstand="true">${p.action}</a:Action>` +
    `<a:To s:mustUnderstand="true">/wsman</a:To>` +
    `<w:ResourceURI s:mustUnderstand="true">${p.resourceUri}</w:ResourceURI>` +
    `<a:MessageID s:mustUnderstand="true">${escapeXml(p.messageId ?? nextMessageId())}</a:MessageID>` +
    `<a:ReplyTo><a:Address>${ANONYMOUS}</a:Address></a:ReplyTo>` +
    `<w:OperationTimeout>PT60S</w:OperationTimeout>` +
    (p.selectors ? selectorSet(p.selectors) : "") +
    `</s:Header>` +
    `<s:Body>${p.body}</s:Body>` +
    `</s:Envelope>`
  );
}

/** 列挙の始め。返事の EnumerationContext で Pull する */
export const enumerate = (resourceUri: string, messageId?: string): string =>
  envelope({
    action: ACTION.enumerate,
    resourceUri,
    body: `<Enumerate xmlns="${NS.enumeration}" />`,
    messageId,
  });

export const pull = (
  resourceUri: string,
  context: string,
  messageId?: string,
): string =>
  envelope({
    action: ACTION.pull,
    resourceUri,
    body:
      `<Pull xmlns="${NS.enumeration}"><EnumerationContext>${escapeXml(context)}</EnumerationContext>` +
      `<MaxElements>999</MaxElements><MaxCharacters>99999</MaxCharacters></Pull>`,
    messageId,
  });

/**
 * 電源の操作。CIM の PowerState の値で頼む。AMT が受けるのは
 * 2 電源を入れる、5 入れ直す、8 切る、10 リセット、12 OS に止めてもらう、14 OS に再起動してもらう(12 と 14 は OS 側の対応が要る)
 */
export const requestPowerStateChange = (
  powerState: number,
  messageId?: string,
): string =>
  envelope({
    action: ACTION.powerChange,
    resourceUri: RESOURCE.powerService,
    selectors: {
      CreationClassName: "CIM_PowerManagementService",
      Name: "Intel(r) AMT Power Management Service",
      SystemCreationClassName: "CIM_ComputerSystem",
      SystemName: "Intel(r) AMT",
    },
    body:
      `<r:RequestPowerStateChange_INPUT xmlns:r="${RESOURCE.powerService}">` +
      `<r:PowerState>${Math.trunc(powerState)}</r:PowerState>` +
      `<r:ManagedElement>` +
      `<Address xmlns="${NS.addressing}">${ANONYMOUS}</Address>` +
      `<ReferenceParameters xmlns="${NS.addressing}">` +
      `<ResourceURI xmlns="${NS.wsman}">${RESOURCE.computerSystem}</ResourceURI>` +
      `<SelectorSet xmlns="${NS.wsman}">` +
      `<Selector Name="CreationClassName">CIM_ComputerSystem</Selector>` +
      `<Selector Name="Name">ManagedSystem</Selector>` +
      `</SelectorSet>` +
      `</ReferenceParameters>` +
      `</r:ManagedElement>` +
      `</r:RequestPowerStateChange_INPUT>`,
    messageId,
  });

/** 名前空間の接頭辞を問わず、その名前の要素の中身をすべて拾う */
export function elements(xml: string, name: string): string[] {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w.-]+:)?${name}>`,
    "g",
  );
  return [...xml.matchAll(re)].map((m) => unescapeXml((m[1] as string).trim()));
}

export const element = (xml: string, name: string): string | undefined =>
  elements(xml, name)[0];

/** SOAP の Fault なら、その理由(Text か Subcode の Value) */
export function fault(xml: string): string | undefined {
  if (!/<(?:[\w.-]+:)?Fault[\s>]/.test(xml)) return undefined;
  return element(xml, "Text") ?? elements(xml, "Value").at(-1) ?? "SOAP Fault";
}

/** CIM_AssociatedPowerManagementService の今の電源の状態と、頼める状態の並び */
export type PowerInfo = { state?: number; available: number[] };

export function parsePower(xml: string): PowerInfo {
  const n = (s: string | undefined) =>
    s === undefined || s === "" ? undefined : Number(s);
  return {
    state: n(element(xml, "PowerState")),
    available: elements(xml, "AvailableRequestedPowerStates")
      .map(Number)
      .filter((v) => Number.isInteger(v)),
  };
}

/** CIM の PowerState(今の状態)の名前 */
export function powerStateName(state: number | undefined): string {
  switch (state) {
    case 2:
      return "オン(S0)";
    case 3:
      return "スリープ(S1)";
    case 4:
      return "スリープ(S3)";
    case 6:
      return "オフ(電源なし)";
    case 7:
      return "休止状態(S4)";
    case 8:
      return "オフ(S5)";
    case 9:
      return "入れ直し中";
    case 13:
      return "オフ";
    case undefined:
      return "不明";
    default:
      return `状態 ${state}`;
  }
}

/** 電源が入っているか(オンかスリープ) */
export const isOn = (state: number | undefined): boolean =>
  state === 2 || state === 3 || state === 4;

/** RequestPowerStateChange の ReturnValue の意味 */
export function returnValueText(v: number | undefined): string {
  switch (v) {
    case 0:
      return "受け付けました";
    case 1:
      return "対応していない操作です(1)";
    case 2:
      return "失敗しました(2)";
    case 3:
      return "時間切れです(3)";
    case 4:
      return "失敗しました(4)";
    case 5:
      return "指定が正しくありません(5)";
    case 4096:
      return "受け付けました(処理中)";
    case undefined:
      return "返事に ReturnValue がありません";
    default:
      return `ReturnValue ${v}`;
  }
}

// ---- IDE-R から起動する(次の 1 回だけ) ----

const AMT_SCHEMA = "http://intel.com/wbem/wscim/1/amt-schema/1/";
export const BOOT = {
  settingData: `${AMT_SCHEMA}AMT_BootSettingData`,
  service: `${CIM}CIM_BootService`,
  configSetting: `${CIM}CIM_BootConfigSetting`,
};
const TRANSFER = "http://schemas.xmlsoap.org/ws/2004/09/transfer/";
const BOOT_CONFIG = "Intel(r) AMT: Boot Configuration 0";

/** AMT_BootSettingData を読む */
export const getBootSettings = (messageId?: string): string =>
  envelope({
    action: `${TRANSFER}Get`,
    resourceUri: BOOT.settingData,
    body: "",
    messageId,
  });

/**
 * Put で送り返さない欄。読み取り専用のものや、配列・入れ子のもの(MeshCentral と同じ)。
 * AMT の版によって無いものもある
 */
const BOOT_READ_ONLY = new Set([
  "BIOSLastStatus",
  "OptionsCleared",
  "UEFIHTTPSBootEnabled",
  "UEFILocalPBABootEnabled",
  "WinREBootEnabled",
  "SecureBootControlEnabled",
  "BootguardStatus",
  "UefiBootParametersArray",
  "UefiBootNumberOfParams",
  "RPEEnabled",
  "RSEPassword",
]);

/** Get の返事から AMT_BootSettingData の単純な欄(名前と値)を順に拾う */
export function bootSettingFields(xml: string): [string, string][] {
  return instanceFields(xml, "AMT_BootSettingData");
}

/** Get の返事から、そのクラスのすぐ下の単純な欄(名前と値)を順に拾う。入れ子の欄(中に要素を持つもの)は拾わない */
export function instanceFields(
  xml: string,
  className: string,
): [string, string][] {
  const m = new RegExp(
    `<(?:[\\w.-]+:)?${className}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${className}>`,
  ).exec(xml);
  if (!m) throw new Error(`AMT の返事に ${className} がありません`);
  const out: [string, string][] = [];
  let depth = 0;
  let open: { name: string; text: string; nested: boolean } | undefined;
  for (const t of (m[1] as string).matchAll(
    /<(\/?)(?:[\w.-]+:)?(\w+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g,
  )) {
    const [, close, name, self, text] = t;
    if (text !== undefined) {
      if (depth === 1 && open) open.text += text;
    } else if (close) {
      depth--;
      if (depth === 0 && open && open.name === name && !open.nested)
        out.push([open.name, unescapeXml(open.text.trim())]);
      if (depth === 0) open = undefined;
    } else if (self) {
      if (depth === 0) out.push([name as string, ""]);
      else if (open) open.nested = true;
    } else {
      if (depth === 0) open = { name: name as string, text: "", nested: false };
      else if (open) open.nested = true;
      depth++;
    }
  }
  return out;
} /**
 * 次の起動を IDE-R の CD-ROM からにする設定。読んだ値を元に UseIDER と IDERBootDevice(1 = CD)を変え、
 * BIOS の画面も SOL に出す(UseSOL)
 */
export function putBootSettingsForIder(
  getReply: string,
  messageId?: string,
): string {
  const fields = new Map(
    bootSettingFields(getReply).filter(([k]) => !BOOT_READ_ONLY.has(k)),
  );
  fields.set("UseIDER", "true");
  fields.set("IDERBootDevice", "1");
  fields.set("UseSOL", "true");
  return envelope({
    action: `${TRANSFER}Put`,
    resourceUri: BOOT.settingData,
    body:
      `<r:AMT_BootSettingData xmlns:r="${BOOT.settingData}">` +
      [...fields].map(([k, v]) => `<r:${k}>${escapeXml(v)}</r:${k}>`).join("") +
      `</r:AMT_BootSettingData>`,
    messageId,
  });
}

/** 次の起動に AMT の起動設定を使う(Role 1 = IsNext) */
export const setBootConfigRole = (messageId?: string): string =>
  envelope({
    action: `${BOOT.service}/SetBootConfigRole`,
    resourceUri: BOOT.service,
    selectors: {
      CreationClassName: "CIM_BootService",
      Name: "Intel(r) AMT Boot Service",
      SystemCreationClassName: "CIM_ComputerSystem",
      SystemName: "Intel(r) AMT",
    },
    body:
      `<r:SetBootConfigRole_INPUT xmlns:r="${BOOT.service}">` +
      `<r:BootConfigSetting>` +
      `<Address xmlns="${NS.addressing}">${ANONYMOUS}</Address>` +
      `<ReferenceParameters xmlns="${NS.addressing}">` +
      `<ResourceURI xmlns="${NS.wsman}">${BOOT.configSetting}</ResourceURI>` +
      `<SelectorSet xmlns="${NS.wsman}"><Selector Name="InstanceID">${BOOT_CONFIG}</Selector></SelectorSet>` +
      `</ReferenceParameters>` +
      `</r:BootConfigSetting>` +
      `<r:Role>1</r:Role>` +
      `</r:SetBootConfigRole_INPUT>`,
    messageId,
  });

/** 起動の順を空にする(IDE-R は UseIDER で選ぶので、ほかの装置を指定しない) */
export const clearBootOrder = (messageId?: string): string =>
  envelope({
    action: `${BOOT.configSetting}/ChangeBootOrder`,
    resourceUri: BOOT.configSetting,
    selectors: { InstanceID: BOOT_CONFIG },
    body: `<r:ChangeBootOrder_INPUT xmlns:r="${BOOT.configSetting}"></r:ChangeBootOrder_INPUT>`,
    messageId,
  });

// ---- リダイレクト(SOL・IDE-R)の受け口 ----

export const REDIRECTION = `${AMT_SCHEMA}AMT_RedirectionService`;

/** EnabledState: 32768 = どちらも無効、32769 = IDE-R だけ、32770 = SOL だけ、32771 = 両方有効 */
export const REDIRECTION_BOTH = 32771;

export const getRedirection = (messageId?: string): string =>
  envelope({
    action: `${TRANSFER}Get`,
    resourceUri: REDIRECTION,
    body: "",
    messageId,
  });

export type RedirectionInfo = {
  /** 16994 / 16995 で待ち受けているか(ListenerEnabled) */
  listener: boolean;
  sol: boolean;
  ider: boolean;
  state: number;
};

export function parseRedirection(xml: string): RedirectionInfo {
  const f = new Map(instanceFields(xml, "AMT_RedirectionService"));
  const state = Number(f.get("EnabledState"));
  return {
    listener: f.get("ListenerEnabled") === "true",
    sol: state === 32770 || state === 32771,
    ider: state === 32769 || state === 32771,
    state,
  };
}

/** SOL と IDE-R を有効にする(RequestStateChange)。MeshCommander と UI Toolkit と同じ */
export const requestRedirectionState = (
  state = REDIRECTION_BOTH,
  messageId?: string,
): string =>
  envelope({
    action: `${REDIRECTION}/RequestStateChange`,
    resourceUri: REDIRECTION,
    body: `<r:RequestStateChange_INPUT xmlns:r="${REDIRECTION}"><r:RequestedState>${Math.trunc(state)}</r:RequestedState></r:RequestStateChange_INPUT>`,
    messageId,
  });

/** 受け口を開く(ListenerEnabled を true にして書き戻す)。AccessLog は読み取り専用の配列なので送らない(MeshCommander と同じ) */
export function putRedirectionListener(
  getReply: string,
  messageId?: string,
): string {
  const fields = new Map(
    instanceFields(getReply, "AMT_RedirectionService").filter(
      ([k]) => k !== "AccessLog",
    ),
  );
  fields.set("ListenerEnabled", "true");
  return envelope({
    action: `${TRANSFER}Put`,
    resourceUri: REDIRECTION,
    body:
      `<r:AMT_RedirectionService xmlns:r="${REDIRECTION}">` +
      [...fields].map(([k, v]) => `<r:${k}>${escapeXml(v)}</r:${k}>`).join("") +
      `</r:AMT_RedirectionService>`,
    messageId,
  });
}
