// src/hcaptcha/fingerprint.ts — TS port of internal/hcaptcha/fingerprint.go
// (reference/go/fingerprint.go): builds the hCaptcha solver fingerprint JSON
// for a challenge — proof_spec fields from the PoW JWT (difficulty/data/
// location), static sample components/events, deterministic xxh3 hash fields,
// a real hashcash stamp (mintStamp at s*2 bits) and a self-consistent CRC-32
// rand element. Returns the fingerprint standard-base64 encoded, the form the
// hsw.js bundle consumes.
import { hashString, mintStamp, randHash, type Pow } from "./pow";

/** Where hCaptcha serves challenge assets and hsw.js bundles; the fingerprint
 * proof_spec._location is built from it plus the JWT "l" claim. */
export const ASSET_BASE = "https://newassets.hcaptcha.com";

/** Static raw content that hash-class component fields stand in for (phase 1
 * ships no browser collection; values are deterministic placeholders). */
const HASH_RAW_BY_FIELD: Record<string, string> = {
  canvas_hash: "hcaptcha-phase1-canvas-placeholder",
  parent_win_hash: "hcaptcha-phase1-parent-window-placeholder",
  performance_hash: "hcaptcha-phase1-performance-placeholder",
};

/** fpTemplate mirrors the reference fingerprint shape (fp_build.go in
 * Implex-ltd/hcaptcha-reverse). Placeholders: __DIF__ (difficulty), __DATA__
 * (pow data), __LOCATION__ (absolute asset URL), _rand (second rand element,
 * bare identifier inside the rand array), __CANVAS_HASH__/__PARENT_WIN_HASH__/
 * __PERF_HASH__ (hash-class fields, substituted at init), __STAMP__
 * (hashcash stamp). */
const FP_TEMPLATE = `{"proof_spec":{"difficulty":__DIF__,"fingerprint_type":0,"_type":"w","data":"__DATA__","_location":"__LOCATION__","timeout_value":1000},"rand":[0.960537614638231,_rand],"components":{"navigator":{"user_agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36","language":"fr-FR","languages":["fr-FR","fr","en-US","en"],"platform":"Win32","max_touch_points":0,"webdriver":false,"notification_query_permission":null,"plugins_undefined":false},"screen":{"color_depth":24,"pixel_depth":24,"width":3440,"height":1440,"avail_width":3440,"avail_height":1392},"device_pixel_ratio":1,"has_session_storage":true,"has_local_storage":true,"has_indexed_db":true,"web_gl_hash":"-1","canvas_hash":"__CANVAS_HASH__","has_touch":false,"notification_api_permission":"Denied","chrome":true,"to_string_length":33,"err_firefox":null,"r_bot_score":0,"r_bot_score_suspicious_keys":[],"r_bot_score_2":0,"audio_hash":"-1","extensions":[false],"parent_win_hash":"__PARENT_WIN_HASH__","webrtc_hash":"-1","performance_hash":"__PERF_HASH__","unique_keys":"1,unisat,hcaptcha,onSuccess,grecaptcha,0,onExpire","inv_unique_keys":"__wdata,_sharedLibs,image_label_binary,hsw,image_label_area_select","common_keys_hash":2614578394,"common_keys_tail":"stop,structuredClone,webkitCancelAnimationFrame,webkitRequestAnimationFrame,chrome,fence,caches,cookieStore,ondevicemotion,ondeviceorientation,ondeviceorientationabsolute,launchQueue,sharedStorage,documentPictureInPicture,getScreenDetails,queryLocalFonts,showDirectoryPicker,showOpenFilePicker,showSaveFilePicker,originAgentCluster,onpagereveal,credentialless,speechSynthesis,onscrollend,webkitRequestFileSystem,webkitResolveLocalFileSystemURL,providers,_phantomHideProvidersArray,_phantomShowMetamaskExplainer,isPhantomInstalled,regeneratorRuntime,SENTRY_RELEASE,web3,Raven,XverseProviders,btc_providers","features":{"performance_entries":true,"web_audio":true,"web_rtc":true,"canvas_2d":true,"fetch":true}},"events":[[2455893439,"\\"Europe/Paris\\""],[1438349120,"13177607191192652685"],[3227950072,"[24,24,65536,212988,200704]"],[3025237892,"12027682292028963860"],[4165641576,"[32767,32767,16384,8,8,8]"],[91877612,"[[[\\"chrome-extension://idnnbdplmphpflfnlkomgpfbpcgelopg/inpage.js\\",0,3],[\\"https://newassets.hcaptcha.com/captcha/v1/17b82e2/hcaptcha.js\\",0,5]],[[\\"*\\",84,9]]]"],[2252840959,"11079656286779448742"],[3487278513,"1135"],[2005859105,"[2147483647,2147483647,4294967294]"],[4272905495,"31.25000000745058"],[188652528,"[16,4095,30,16,16380,120,12,120,[23,127,127]]"],[2062697704,"[[277114314453,277114314460,277114314451,357114314456,277114314452,554228628898,57114314443,717114314371391,554228628897,277114314456,1108457257862,277114314450,554228628919,277114314460,277114314451],false]"],[1325100515,"true"],[1268522788,"[16384,32,16384,2048,2,2048]"],[1108939890,"[\\"Europe/Paris\\",-60,-60,-3203647761000,\\"heure normale d’Europe centrale\\",\\"fr\\"]"],[1579262840,"[-6.172840118408203,-20.710678100585938,120.71067810058594,-20.710678100585938,141.42135620117188,120.71067810058594,-20.710678100585938,141.42135620117188,-20.710678100585938,-20.710678100585938,0,0,320,490,true]"],[2158825350,"[1,1024,1,1,4]"],[2509526170,"[2147483647,2147483647,2147483647,2147483647]"],[28433086,"16.400000005960464"],[2284058841,"40224"],[522949833,"[\\"QzM1IjN5gzMYCDMX\\",\\"c\\",\\"1\\",\\"XAWOPPOCYTLBS\\"]"],[2150450975,"16132118391739044799"],[2228825458,"1712155469384.5"],[639595872,"1444582"],[3197530747,"[3440,1440,3440,1392,24,24,false,0,1,2353,1399,true,true,true,false]"],[930901639,"41.70000000298023"],[3095117296,"[\\"5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36\\",\\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36\\",8,16,\\"fr-FR\\",[\\"fr-FR\\",\\"fr\\",\\"en-US\\",\\"en\\"],\\"Win32\\",null,[\\"Google Chrome 123\\",\\"Not:A-Brand 8\\",\\"Chromium 123\\"],false,\\"Windows\\",2,5,true,false,0,false,false,true,\\"[object Keyboard]\\",false,false]"],[2545605315,"[[\\"LwitJG5mBmTGZo0uvinesalCMYuCsTJm\\",\\"19\\",\\"13\\",\\"TUEENBUIKYSVN\\"],[\\"VQoLKtgnKmLajmLY0umfLS=K0mJftmPajmLuHeFVZXwmKmLajmLEgeFVZXwajmLKKb3PgA5ntSxEDmyuCkwmgmwaDmyQDo5KCmyuSWUBjmLmDm2aDmyuyVznEmyuCtqTEd3hMAwItJtfKtJ5KRwItJOm\\",\\"5\\",\\"82\\",\\"KLMGOTNTZAUFP\\"]]"],[3467501445,"57"],[262879291,"8398791803026140725"],[3570513324,"4631229088072584217"],[3235903591,"[[true,\\"fr-FR\\",true,\\"Microsoft Hortense - French (France)\\",\\"Microsoft Hortense - French (France)\\"],[false,\\"fr-FR\\",true,\\"Microsoft Julie - French (France)\\",\\"Microsoft Julie - French (France)\\"],[false,\\"fr-FR\\",true,\\"Microsoft Paul - French (France)\\",\\"Microsoft Paul - French (France)\\"]]"],[1019203231,"[[\\"loadTimes\\",\\"csi\\",\\"app\\"],35,34,null,false,false,true,37,true,true,true,true,true,[\\"providers\\",\\"_phantomHideProvidersArray\\",\\"_phantomShowMetamaskExplainer\\",\\"isPhantomInstalled\\",\\"regeneratorRuntime\\",\\"SENTRY_RELEASE\\",\\"web3\\",\\"Raven\\",\\"_sharedLibs\\",\\"XverseProviders\\",\\"btc_providers\\",\\"hsw\\",\\"__wdata\\",\\"image_label_area_select\\",\\"image_label_binary\\",\\"ethereum\\",\\"phantom\\",\\"solana\\",\\"rabby\\",\\"rabbyWalletRouter\\",\\"StacksProvider\\",\\"BitcoinProvider\\"],[[\\"getElementsByClassName\\",[]],[\\"getElementById\\",[]],[\\"querySelector\\",[]],[\\"querySelectorAll\\",[]]],[],true]"],[2840639612,"[1,4,5,7,9,12,20,21,24,25,29,31]"],[1538111826,"17157476241021694346"],[4250147733,"15307345790125003576"],[2963547975,"[16,1024,4096,7,12,120,[23,127,127]]"],[1007274290,"9345374751420407194"],[2772590518,"[\\"Google Inc. (NVIDIA)\\",\\"ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)\\"]"],[104149656,"[0,1,2,3,4]"],[4173238370,"[[\\"img:imgs3.hcaptcha.com\\",0,25.55000000447035],[\\"navigation:newassets.hcaptcha.com\\",19.80000001192093,33.29999999701977],[\\"script:newassets.hcaptcha.com\\",16.25000000745058,29.899999998509884],[\\"xmlhttprequest:api.hcaptcha.com\\",0,204.59999999403954]]"],[1177832592,"[143526983270,143526983270,null,null,4294705152,true,true,true,null]"],[2163086961,"412.09999999403954"],[2416260428,"4932383211497360507"],[2444509564,"[\\"Windows\\",\\"15.0.0\\",null,\\"64\\",\\"x86\\",\\"123.0.6312.86\\"]"],[611315898,"8915205951503093450"],[850956849,"2944899007327630659"],[728511561,"4807243413252001311"],[1668959119,"631"],[1246555942,"[17]"],[3197521464,"18207788058829391080"],[1826871708,"[[221,[221,221,221,255,221,221,221,255,221,221,221,255,221,221,221,255]],[[11,0,0,95.96875,15,4,96.765625],[[12,0,-1,113.125,17,4,113],[11,0,0,111,12,4,111],[11,0,0,95.96875,15,4,96.765625],[11,0,0,95.96875,15,4,96.765625],[11,0,0,95.96875,15,4,96.765625],[11,0,0,95.96875,15,4,96.765625],[11,0,0,95.96875,15,4,96.765625],[11,0,0,95.96875,15,4,96.765625],[12,0,0,109.640625,14,3,110.1953125]]],[0,2,8,13,15,17,24,26,27,28,29,30,31,32,34,37,39,40,49,69,75,76,79,80],[0,0,0,0,14,3,0]]"],[2970644973,"[\\"va6FXY=00Y6DHetZkmlG\\",\\"8\\",\\"e\\",\\"ORGCVWSNOSDMJ\\"]"],[2620085432,"[4,120,4]"],[2974784595,"[0,10465,10465]"]],"suspicious_events":[],"messages":null,"stack_data":["Array.reduce (<anonymous>)\\nonMessage (chrome-extension://gppongmhjkpfnbhagpmjfkannfbllamg/js/dom.js)","new Promise (<anonymous>)"],"stamp":"__STAMP__","href":"https://accounts.hcaptcha.com/demo","ardata":null,"errs":{"list":[]},"perf":[[1,6],[2,416]]}`;

// --- init: substitute hash placeholders, then split once at the remaining
// placeholder boundaries (mirrors fingerprint.go init + cut2) ---

function cut2(s: string, placeholder: string): [before: string, after: string] {
  const i = s.indexOf(placeholder);
  if (i < 0) throw new Error("hcaptcha: fingerprint template missing placeholder " + placeholder);
  return [s.slice(0, i), s.slice(i + placeholder.length)];
}

const TEXT_ENCODER = new TextEncoder();

/** base64 (standard alphabet) over UTF-8 bytes. */
function b64StdEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Go strconv.AppendFloat(v, 'f', -1, 64): shortest round-trip digits, NEVER
 * exponent notation. JS String() matches except for |v| < 1e-6 / >= 1e21
 * (~0.1% of rand values); expand those exactly. */
function fmtFloat(v: number): string {
  const s = String(v);
  if (!s.includes("e") && !s.includes("E")) return s;
  const [mant, exp] = s.split(/[eE]/);
  const e = parseInt(exp!, 10);
  const [int, frac = ""] = mant!.split(".");
  const digits = int! + frac;
  const point = int!.length + e;
  if (point <= 0) return "0." + "0".repeat(-point) + digits;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return digits.slice(0, point) + "." + digits.slice(point);
}

const HASH_VALS: Record<string, string> = {};
let segBeforeDif: string, segDifToData: string, segDataToLoc: string, segLocToRand: string, segRandToStamp: string, segAfterRand: string;
{
  for (const f of ["canvas_hash", "parent_win_hash", "performance_hash"]) {
    HASH_VALS[f] = hashString(HASH_RAW_BY_FIELD[f]!);
  }
  let tpl = FP_TEMPLATE
    .replace("__CANVAS_HASH__", HASH_VALS["canvas_hash"]!)
    .replace("__PARENT_WIN_HASH__", HASH_VALS["parent_win_hash"]!)
    .replace("__PERF_HASH__", HASH_VALS["performance_hash"]!);
  [segBeforeDif, tpl] = cut2(tpl, "__DIF__");
  [segDifToData, tpl] = cut2(tpl, "__DATA__");
  [segDataToLoc, tpl] = cut2(tpl, "__LOCATION__");
  [segLocToRand, tpl] = cut2(tpl, "_rand");
  [segRandToStamp, segAfterRand] = cut2(tpl, "__STAMP__");
}

/** locationURL normalizes the JWT "l" claim into the absolute asset URL:
 * full URL unchanged; "/c/<id>" or bare "<id>" prefixed with AssetBase
 * (fingerprint.go:194-204). hsw.js download follows the same conventions. */
export function locationURL(loc: string): string {
  loc = loc.replace(/\/$/, "");
  if (loc.startsWith("http://") || loc.startsWith("https://")) return loc;
  if (loc.startsWith("/")) return ASSET_BASE + loc;
  return ASSET_BASE + "/c/" + loc;
}

/** BuildFingerprint renders the hCaptcha fingerprint JSON for the challenge
 * described by pow and returns it standard-base64 encoded
 * (fingerprint.go:126-183). Throws Error on missing pow fields, stamp mint
 * failure (incl. PowBudgetExceeded) or invalid output JSON. */
export function buildFingerprint(pow: Pow): string {
  if (!pow || pow.powData === "" || pow.location === "") {
    throw new Error("hcaptcha: fingerprint: pow missing data/location");
  }
  const stamp = mintStamp(pow.difficulty * 2, pow.powData);

  // Head through the comma right before the rand element (segLocToRand ends
  // with ","; the static rand[0] float stays in the template).
  let head = segBeforeDif + fmtFloat(pow.difficulty) + segDifToData + pow.powData +
    segDataToLoc + locationURL(pow.location) + segLocToRand;

  // CRC-32 over the payload with ",_rand" removed (rand[1] dropped; the
  // closing bracket comes from segRandToStamp itself) + stamp + tail —
  // exactly the reference builder's integrity input.
  const crcInput = head.slice(0, -1) + segRandToStamp + stamp + segAfterRand;
  const { randVal } = randHash(TEXT_ENCODER.encode(crcInput));

  const json = head + fmtFloat(randVal) + segRandToStamp + stamp + segAfterRand;
  try {
    JSON.parse(json);
  } catch {
    throw new Error("hcaptcha: fingerprint: produced invalid JSON");
  }
  return b64StdEncode(TEXT_ENCODER.encode(json));
}
