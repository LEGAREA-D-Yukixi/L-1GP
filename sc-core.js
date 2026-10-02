/* =========================================================
   LEGAREA SkillCheck — コアロジック
   ブラウザ / Node どちらからも読み込めます（テスト用）
   ========================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------
     入力バリデーション
     --------------------------------------------------------- */

  function normalizeName(raw) {
    if (raw == null) return '';
    return String(raw)
      .replace(/[\u3000\s]+/g, ' ')   // 全角スペース含め1つの半角スペースへ
      .trim();
  }

  function validateName(raw) {
    const name = normalizeName(raw);
    if (!name) return { ok: false, value: '', msg: '氏名を入力してください' };
    if (name.length < 2) return { ok: false, value: name, msg: '氏名は2文字以上で入力してください' };
    if (name.length > 40) return { ok: false, value: name, msg: '氏名は40文字以内で入力してください' };
    return { ok: true, value: name, msg: '' };
  }

  // 生年月日として受け付ける最も古い日付（カレンダーの表示下限と揃える）
  const BIRTH_MIN = '1900-01-01';

  // today は 'YYYY-MM-DD'（省略時は実行日）
  function validateBirth(raw, today) {
    const s = String(raw || '').trim();
    if (!s) return { ok: false, value: '', msg: '生年月日を入力してください' };
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return { ok: false, value: '', msg: '生年月日の形式が正しくありません' };
    const y = +m[1], mo = +m[2], d = +m[3];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
      return { ok: false, value: '', msg: '存在しない日付です' };
    }
    if (s < BIRTH_MIN) return { ok: false, value: s, msg: '1900年以降の日付を入力してください' };
    const now = today ? new Date(today + 'T00:00:00Z') : new Date();
    if (dt.getTime() > now.getTime()) return { ok: false, value: '', msg: '未来の日付は入力できません' };
    const age = ageAt(s, isoDate(now));
    if (age < 15) return { ok: false, value: s, msg: '15歳未満は受験できません' };
    return { ok: true, value: s, msg: '' };
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function ageAt(birth, on) {
    const b = String(birth).split('-').map(Number);
    const o = String(on).split('-').map(Number);
    let age = o[0] - b[0];
    if (o[1] < b[1] || (o[1] === b[1] && o[2] < b[2])) age--;
    return age;
  }

  /* ---------------------------------------------------------
     乱数（テスト時はシード固定で再現可能）
     --------------------------------------------------------- */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rnd) {
    const r = rnd || Math.random;
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------------------------------------------------
     出題生成
     pool : sc-questions.js の1言語分の配列
     opts : { count, shuffleQuestions, shuffleChoices, rnd }
     --------------------------------------------------------- */

  function buildExam(langKey, pool, opts) {
    const o = opts || {};
    const rnd = o.rnd || Math.random;
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('問題が登録されていません: ' + langKey);
    }
    let indexed = pool.map(function (q, i) {
      return { qid: langKey + '-' + (i + 1), src: q };
    });
    if (o.shuffleQuestions !== false) indexed = shuffle(indexed, rnd);

    const n = (!o.count || o.count <= 0) ? indexed.length : Math.min(o.count, indexed.length);
    indexed = indexed.slice(0, n);

    return indexed.map(function (item) {
      const src = item.src;
      let pairs = src.choices.map(function (text, i) { return { text: text, correct: i === src.a }; });
      if (o.shuffleChoices !== false) pairs = shuffle(pairs, rnd);
      return {
        qid: item.qid,
        q: src.q,
        choices: pairs.map(function (p) { return p.text; }),
        answer: pairs.findIndex(function (p) { return p.correct; }),
        exp: src.exp || '',
      };
    });
  }

  /* ---------------------------------------------------------
     採点
     answers : 選択したインデックスの配列（未回答は null）
     --------------------------------------------------------- */

  // 選択式の採点。pointPer は1問あたりの配点（既定10点）
  function gradeExam(exam, answers, passLine, pointPer) {
    const line = typeof passLine === 'number' ? passLine : 70;
    const per = pointPer == null ? 10 : pointPer;
    const total = exam.length;
    const details = exam.map(function (item, i) {
      const picked = (answers && answers[i] != null) ? answers[i] : null;
      return {
        qid: item.qid,
        q: item.q,
        choices: item.choices,
        picked: picked,
        answer: item.answer,
        ok: picked === item.answer,
        exp: item.exp,
      };
    });
    const correct = details.filter(function (d) { return d.ok; }).length;
    const pct = scoreOf(correct, total);
    return {
      total: total,
      correct: correct,
      score: correct * per,
      max: total * per,
      pointPer: per,
      pct: pct,
      passed: pct >= line,
      passLine: line,
      rank: rankOf(pct),
      details: details,
    };
  }

  /* 選択式と記述式を合算した成績
     choiceScore : 選択式の得点（＝正解数）
     choiceMax   : 選択式の問題数
     codeScore   : 記述式の得点。未審査なら null
     codeCount   : 記述式の問題数
     codeMax     : 記述式1問あたりの満点 */
  function totalScore(o) {
    const s = o || {};
    const choiceScore = s.choiceScore || 0;
    const choiceMax = s.choiceMax || 0;
    const codeCount = s.codeCount || 0;
    const codeMax = s.codeMax == null ? 10 : s.codeMax;
    const line = typeof s.passLine === 'number' ? s.passLine : 70;
    const complete = codeCount === 0 || (s.codeScore != null);
    const codeScore = s.codeScore == null ? 0 : s.codeScore;
    const max = choiceMax + codeCount * codeMax;
    const score = choiceScore + codeScore;
    const pct = max ? Math.round((score / max) * 100) : 0;
    return {
      score: score,
      max: max,
      pct: pct,
      rank: rankOf(pct),
      passed: complete && pct >= line,
      passLine: line,
      complete: complete,
    };
  }

  function scoreOf(correct, total) {
    if (!total) return 0;
    return Math.round((correct / total) * 100);
  }

  function rankOf(score) {
    if (score >= 90) return 'S';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 50) return 'C';
    return 'D';
  }

  function unanswered(exam, answers) {
    const out = [];
    for (let i = 0; i < exam.length; i++) {
      if (!answers || answers[i] == null) out.push(i);
    }
    return out;
  }

  function progressText(answers, total) {
    const done = (answers || []).filter(function (v) { return v != null; }).length;
    return done + ' / ' + total;
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + '分' + String(r).padStart(2, '0') + '秒';
  }

  /* ---------------------------------------------------------
     本人確認の方式決定
     --------------------------------------------------------- */

  // 受験を開始できるか。録画する設定なら同意が必要
  function canStart(state, needConsent) {
    const s = state || {};
    if (!s.nameOk || !s.birthOk) return false;
    if (needConsent === false) return true;
    return !!s.consent;
  }

  /* ---------------------------------------------------------
     エラーメッセージの日本語化
     ブラウザやAPIが返す英文をそのまま画面に出さないための変換
     --------------------------------------------------------- */

  const CAMERA_ERRORS = {
    NotAllowedError:     'カメラの使用が許可されていません。ブラウザの設定から許可してください',
    NotFoundError:       'カメラが見つかりません',
    NotReadableError:    'カメラを使用できません。他のアプリが使用中の可能性があります',
    OverconstrainedError:'利用できるカメラがありません',
    SecurityError:       '安全な接続（https）で開かれていないため利用できません',
    AbortError:          'カメラの起動が中断されました',
  };

  function jaCameraError(e) {
    if (!e) return 'カメラを利用できません';
    return CAMERA_ERRORS[e.name] || 'カメラを利用できません';
  }

  function jaHttpError(status) {
    if (status === 0)   return 'ネットワークに接続できません';
    if (status === 401) return '接続キーが正しくありません';
    if (status === 403) return '保存する権限がありません';
    if (status === 404) return '保存先が見つかりません';
    if (status === 409) return 'すでに同じ記録が登録されています';
    if (status === 413) return 'データが大きすぎます';
    if (status === 429) return 'アクセスが集中しています。しばらく待ってからお試しください';
    if (status >= 500)  return 'サーバー側で問題が発生しています';
    return '保存に失敗しました';
  }

  function jaAuthError(status, code) {
    const c = String(code || '');
    if (status === 0) return 'ネットワークに接続できません';
    if (/email_not_confirmed/.test(c))   return 'メールアドレスの確認が完了していません';
    if (/invalid_credentials|invalid_grant/.test(c)) return 'メールアドレスまたはパスワードが正しくありません';
    if (/user_banned/.test(c))           return 'このアカウントは利用できません';
    if (status === 400 || status === 401) return 'メールアドレスまたはパスワードが正しくありません';
    if (status === 429) return 'ログインの試行が多すぎます。しばらく待ってからお試しください';
    if (status >= 500)  return 'サーバー側で問題が発生しています';
    return 'ログインできませんでした';
  }

  /* ---------------------------------------------------------
     記述問題（写経）の照合
     採点は管理画面での目視ですが、一致率を参考値として添えます
     --------------------------------------------------------- */

  // 行末の空白と余分な空行を整え、インデントは保ったまま比較できる形にする
  function normalizeCode(src) {
    return String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(function (line) { return line.replace(/[ \t]+$/, ''); })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 空白を畳んだ比較用の形（インデント差を無視する）
  function squashCode(src) {
    return normalizeCode(src).replace(/[ \t]+/g, ' ');
  }

  // 0-100 の一致率。完全一致は100
  function codeMatch(submitted, answer) {
    const a = normalizeCode(submitted);
    const b = normalizeCode(answer);
    if (!b) return 0;
    if (a === b) return 100;
    const sa = squashCode(a), sb = squashCode(b);
    if (sa === sb) return 98;          // インデントのみ相違
    return Math.round(similarity(sa, sb) * 97);
  }

  // 行単位の最長共通部分列から類似度を出す
  function similarity(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    if (!x.length || !y.length) return 0;
    let prev = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
      const cur = new Array(y.length + 1).fill(0);
      for (let j = 1; j <= y.length; j++) {
        cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return (2 * prev[y.length]) / (x.length + y.length);
  }

  function codeVerdict(pct) {
    if (pct >= 100) return '完全一致';
    if (pct >= 98) return 'インデントのみ相違';
    if (pct >= 80) return 'ほぼ一致';
    if (pct >= 40) return '一部一致';
    return '要確認';
  }

  const api = {
    normalizeName: normalizeName,
    jaCameraError: jaCameraError,
    jaHttpError: jaHttpError,
    jaAuthError: jaAuthError,
    validateName: validateName,
    validateBirth: validateBirth,
    BIRTH_MIN: BIRTH_MIN,
    ageAt: ageAt,
    isoDate: isoDate,
    mulberry32: mulberry32,
    shuffle: shuffle,
    buildExam: buildExam,
    gradeExam: gradeExam,
    scoreOf: scoreOf,
    totalScore: totalScore,
    rankOf: rankOf,
    unanswered: unanswered,
    progressText: progressText,
    formatDuration: formatDuration,
    canStart: canStart,
    normalizeCode: normalizeCode,
    codeMatch: codeMatch,
    codeVerdict: codeVerdict,
  };

  /* =========================================================
     ここから下はブラウザ専用（本人確認・保存）
     ========================================================= */
  if (typeof window === 'undefined') return api;

  const cfg = function () { return window.SC_CONFIG || {}; };

  /* ---- バイト列 <-> base64url ---- */
  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlToBuf(str) {
    const s = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? '===='.slice(s.length % 4) : '';
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function randomBytes(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }

  /* ---- 端末が何に対応しているか ---- */
  async function detectCaps() {
    const caps = {
      camera: false,
      secure: typeof window !== 'undefined' ? !!window.isSecureContext : false,
      recorder: false,
      screen: 'none',
    };
    try {
      caps.camera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    } catch (e) { caps.camera = false; }
    if (!caps.secure) caps.camera = false;
    caps.recorder = canRecord();
    caps.screen = caps.secure ? screenCaptureSupport() : 'none';
    return caps;
  }

  /* ---- カメラの停止（録画・プレビュー共通） ---- */
  function closeCamera(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
  }

  /* =========================================================
     録画（カメラ映像のみ）
     画面は撮らず、代わりに操作ログを記録します。
     模範解答はログにも映像にも一切入りません。
     ========================================================= */

  function pickMime() {
    const list = [
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=avc1',   // Safari
      'video/mp4',
    ];
    if (typeof MediaRecorder === 'undefined') return '';
    if (!MediaRecorder.isTypeSupported) return 'video/mp4';
    for (let i = 0; i < list.length; i++) {
      if (MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  function canRecord() {
    return typeof MediaRecorder !== 'undefined' && !!pickMime();
  }

  /* ---- 接続されているカメラの一覧（外付けカメラの選択用） ---- */
  async function listCameras() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(function (d) { return d.kind === 'videoinput'; })
                .map(function (d, i) {
                  return { id: d.deviceId, label: d.label || ('カメラ ' + (i + 1)) };
                });
    } catch (e) { return []; }
  }

  async function openCameraStream(deviceId, opts) {
    const o = opts || {};
    const video = { width: { ideal: o.width || 320 }, frameRate: { ideal: o.fps || 10 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = 'user';
    return await navigator.mediaDevices.getUserMedia({ video: video, audio: false });
  }

  /* =========================================================
     画面録画（模範解答を映さない）

     getDisplayMedia はタブ全体を撮るため、そのままでは模範解答も写ります。
     そこで「このタブ」を選ばせたうえで、撮影範囲を解答エリアだけに絞ります。

       Element Capture (restrictTo) … 指定要素の配下だけを撮る。Chrome 132+
       Region Capture  (cropTo)     … 指定要素の矩形で切り抜く。Chrome 104+

     どちらも使えない場合は画面録画を行いません（模範解答が漏れるため）。
     ========================================================= */

  function tagged(msg, code) {
    const e = new Error(msg);
    e.code = code;
    return e;
  }

  function screenCaptureSupport() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices ||
        !navigator.mediaDevices.getDisplayMedia) return 'none';
    const proto = (typeof MediaStreamTrack !== 'undefined' &&
                   window.BrowserCaptureMediaStreamTrack &&
                   window.BrowserCaptureMediaStreamTrack.prototype) || null;
    if (window.RestrictionTarget && proto && proto.restrictTo) return 'element';
    if (window.CropTarget && proto && proto.cropTo) return 'region';
    if (window.RestrictionTarget) return 'element';
    if (window.CropTarget) return 'region';
    return 'manual';   // 絞り込みAPIが無くても合成時に切り出せる
  }

  // el : 録画してよい領域のルート要素（模範解答はこの外側に置くこと）
  /* =========================================================
     画面全体を撮る場合の位置あわせ

     モニタ全体の映像には、ブラウザの表示領域がどこにあるかの情報が無い。
     そのままでは解答欄の位置を計算できず、模範解答を隠せない。
     そこで表示領域の四隅に目印を置き、映像の中からその色を探して
     「表示領域 → 映像」の対応を実測する。
     見つからなければ画面は録画しない（安全側）。
     ========================================================= */

  const MARK_A = [255, 0, 255];   // 左上
  const MARK_B = [0, 255, 255];   // 右下
  const MARK_C = [255, 255, 0];   // 右上（測定結果の検算用）
  const MARK_PX = 14;

  function makeMarks() {
    const mk = function (id, color, css) {
      let e = document.getElementById(id);
      if (!e) {
        e = document.createElement('div');
        e.id = id;
        e.setAttribute('aria-hidden', 'true');
        document.body.appendChild(e);
      }
      e.style.cssText = 'position:fixed;width:' + MARK_PX + 'px;height:' + MARK_PX + 'px;'
        + 'background:' + color + ';z-index:2147483647;pointer-events:none;opacity:1;' + css;
      return e;
    };
    return {
      a: mk('sc-mark-a', 'rgb(255,0,255)', 'left:0;top:0'),
      b: mk('sc-mark-b', 'rgb(0,255,255)', 'right:0;bottom:0'),
      c: mk('sc-mark-c', 'rgb(255,255,0)', 'right:0;top:0'),
    };
  }

  function removeMarks() {
    ['sc-mark-a', 'sc-mark-b', 'sc-mark-c'].forEach(function (id) {
      const e = document.getElementById(id);
      if (e && e.parentNode) e.parentNode.removeChild(e);
    });
  }

  // 映像から目印の中心を探す。近い色だけを拾い重心を取る
  function findMark(data, w, h, rgb, tol) {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        if (Math.abs(data[i] - rgb[0]) <= tol &&
            Math.abs(data[i + 1] - rgb[1]) <= tol &&
            Math.abs(data[i + 2] - rgb[2]) <= tol) { sx += x; sy += y; n++; }
      }
    }
    if (n < 6) return null;
    return { x: sx / n, y: sy / n, n: n };
  }

  // 表示領域 → 映像 の対応を求める
  async function calibrateScreen(video) {
    const iw = window.innerWidth, ih = window.innerHeight;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!iw || !ih || !vw || !vh) return null;

    makeMarks();
    await new Promise(function (r) { setTimeout(r, 400); });   // 目印が映るまで待つ

    const cv = document.createElement('canvas');
    cv.width = vw; cv.height = vh;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(video, 0, 0, vw, vh);
    let img;
    try { img = c.getImageData(0, 0, vw, vh); } catch (e) { return null; }

    const a = findMark(img.data, vw, vh, MARK_A, 40);
    const b = findMark(img.data, vw, vh, MARK_B, 40);
    const cc = findMark(img.data, vw, vh, MARK_C, 40);
    if (!a || !b || !cc) return null;
    if (b.x <= a.x || b.y <= a.y) return null;

    // 目印の中心は表示領域の端から MARK_PX/2 の位置にある
    const half = MARK_PX / 2;
    const kx = (b.x - a.x) / Math.max(1, (iw - MARK_PX));
    const ky = (b.y - a.y) / Math.max(1, (ih - MARK_PX));
    if (!(kx > 0.05 && kx < 8) || !(ky > 0.05 && ky < 8)) return null;
    // 縦横で倍率が違う場合は測定を信用しない
    if (Math.abs(kx - ky) / Math.max(kx, ky) > 0.05) return null;

    const cal = { ox: a.x - half * kx, oy: a.y - half * ky, kx: kx, ky: ky };

    // 3点目が計算どおりの位置にあるか検算する。
    // ずれていれば模範解答を隠し損ねる恐れがあるので採用しない。
    const predX = cal.ox + (iw - half) * cal.kx;
    const predY = cal.oy + half * cal.ky;
    const tol = Math.max(6, (b.x - a.x) * 0.02);
    if (Math.abs(predX - cc.x) > tol || Math.abs(predY - cc.y) > tol) return null;

    return cal;
  }

  // opts.narrow が false なら絞り込まず、タブ全体をそのまま撮る
  async function startScreenCapture(el, opts) {
    const wide = !el || (opts && opts.narrow === false);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw tagged('このブラウザは画面録画に対応していません', 'unsupported');
    }
    let stream;
    try {
      const want = (opts && opts.surface) || 'browser';
      const req = {
        video: { frameRate: { ideal: 8 } },
        audio: false,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
      };
      if (want === 'browser') { req.video.displaySurface = 'browser'; req.preferCurrentTab = true; }
      else { req.video.displaySurface = 'monitor'; req.monitorTypeSurfaces = 'include'; }
      stream = await navigator.mediaDevices.getDisplayMedia(req);
    } catch (e) {
      throw tagged('画面の共有が許可されませんでした', 'denied');
    }
    const track = stream.getVideoTracks()[0];
    const stop = function () { stream.getTracks().forEach(function (t) { t.stop(); }); };

    const surface = (track.getSettings && track.getSettings().displaySurface) || '';

    // 受け手が一度もなくなるとタブキャプチャは止まるため、
    // 検証用の video をそのまま合成でも使い回す（破棄しない）。
    const view = videoFrom(stream);
    const stopAll = function () { removeVideo(view); stop(); };

    // まず素のまま映像が流れることを確かめる
    if (!(await nextFrame(view, 4000))) {
      stopAll();
      throw tagged('画面の映像を取得できませんでした', 'no-frames');
    }

    // 画面全体やウィンドウを選ばれた場合は、表示領域の位置を実測してから使う
    if (surface !== 'browser') {
      const cal = await calibrateScreen(view);
      if (!cal) {
        removeMarks(); stopAll();
        throw tagged('画面内のブラウザ位置を特定できませんでした。'
          + 'ブラウザが映る画面を選び直すか、「このタブ」を選んでください', 'no-calib');
      }
      return { stream: stream, mode: 'screen', stop: function(){ removeMarks(); stopAll(); },
               video: view, calib: cal, recalibrate: function(){ return calibrateScreen(view); } };
    }

    // タブ全体を録画する場合はここで終わり（絞り込まない）
    if (wide) return { stream: stream, mode: 'tab', stop: stopAll, video: view };

    // 撮影範囲を解答エリアに絞る。
    // 対象要素が条件を満たさないと、成功を返したまま1フレームも届かないことがあるため、
    // 絞ったあとに必ず映像を確かめ、駄目なら元に戻す。
    // 解除の呼び出しが返らない場合もあるので、すべてタイムアウト付きで扱う。
    let mode = 'manual';   // どれも使えない場合は合成時に切り出す
    if (window.RestrictionTarget && track.restrictTo) {
      try {
        const target = await limit(window.RestrictionTarget.fromElement(el), 3000);
        await limit(track.restrictTo(target), 3000);
        if (await nextFrame(view, 2000) && geometryMatches(view, el)) mode = 'element';
        else await limit(track.restrictTo(null), 3000).catch(function () {});
      } catch (e) { /* 次の方式を試す */ }
    }
    if (mode === 'manual' && window.CropTarget && track.cropTo) {
      try {
        const target = await limit(window.CropTarget.fromElement(el), 3000);
        await limit(track.cropTo(target), 3000);
        if (await nextFrame(view, 2000) && geometryMatches(view, el)) mode = 'region';
        else await limit(track.cropTo(null), 3000).catch(function () {});
      } catch (e) { /* 合成時に切り出す */ }
    }
    // 絞り込みを解除した直後は映像が止まっていることがあるので最後に確認する
    if (!(await nextFrame(view, 2000))) {
      stopAll();
      throw tagged('画面の映像が途切れました', 'no-frames');
    }
    // mode が 'manual' のままでも、合成時に受験カードの範囲だけを描くので模範解答は映らない
    return { stream: stream, mode: mode, stop: stopAll, video: view };
  }

  // 応答が返らない呼び出しで止まらないようにする
  function limit(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) {
        setTimeout(function () { rej(tagged('応答がありません', 'timeout')); }, ms);
      }),
    ]);
  }

  /* 映像が本当に対象要素の範囲になっているかを縦横比で確かめる。
     restrictTo / cropTo は成功を返しても絞り込みが効いていないことがあり、
     それを見逃すと範囲外（模範解答など）が録画に入ってしまう。 */
  function geometryMatches(view, el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || !view.videoWidth || !view.videoHeight) return false;
    const want = r.width / r.height;
    const got = view.videoWidth / view.videoHeight;
    return Math.abs(want - got) / want < 0.04;
  }

  // 次のフレームが実際に届くかを確かめる。
  // 絞り込みに失敗すると「成功を返したまま以後1フレームも来ない」ため、
  // 寸法ではなくフレームの到着そのものを見る。
  function nextFrame(video, ms) {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function (v) { if (!done) { done = true; resolve(v); } };
      setTimeout(function () { finish(false); }, ms || 2000);
      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(function () { finish(true); });
        return;
      }
      const iv = setInterval(function () {
        if (video.videoWidth > 0 && video.videoHeight > 0) { clearInterval(iv); finish(true); }
      }, 100);
      setTimeout(function () { clearInterval(iv); }, ms || 2000);
    });
  }

  /* ---- 画面とカメラを1本の映像に合成する ---- */
  // DOM に載っていない video はフレームを更新しない環境があるため、画面外に配置する
  function videoFrom(stream) {
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(v);
    const p = v.play();
    if (p && p.catch) p.catch(function () {});
    return v;
  }

  function removeVideo(v) {
    if (!v) return;
    try { v.pause(); } catch (e) {}
    v.srcObject = null;
    if (v.parentNode) v.parentNode.removeChild(v);
  }

  /* 除外範囲を広げる。
     日本語入力の変換候補はOSが描くため要素として取れない。
     変換中だけ下方向に広げて録画から外す。 */

  /* 穴を埋める色は、映像に描かれた周囲の画素から拾う。
     固定色で塗ると、映像側の白と微妙に違って境目が見えてしまうため。 */
  function pickFill(ctx, w, h, hole, fallback) {
    const pts = [
      [hole.x - 5, hole.y + hole.h / 2],
      [hole.x + hole.w + 5, hole.y + hole.h / 2],
      [hole.x + hole.w / 2, hole.y - 5],
      [hole.x + hole.w / 2, hole.y + hole.h + 5],
    ];
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < pts.length; i++) {
      const x = Math.round(pts[i][0]), y = Math.round(pts[i][1]);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      try {
        const d = ctx.getImageData(x, y, 1, 1).data;
        r += d[0]; g += d[1]; b += d[2]; n++;
      } catch (e) { /* 読めない場合は既定色 */ }
    }
    if (!n) return fallback || '#ffffff';
    return 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
  }

  /* 画面の映像は数フレーム遅れて届く。
     いま測った位置で描くと、動いた直後だけ映像と合わず一瞬ずれて見える。
     そこで位置の履歴を持ち、映像が写しているであろう少し前の位置を使う。
     動いている間は新旧の位置をまとめた範囲を抜き、はみ出しも防ぐ。 */
  function laggedRect(log, cur, lagMs) {
    const now = Date.now();
    log.push({ t: now, r: cur });
    while (log.length > 1 && now - log[0].t > lagMs + 600) log.shift();

    let use = log[0].r;
    for (let i = 0; i < log.length; i++) {
      if (now - log[i].t <= lagMs) break;
      use = log[i].r;
    }
    // 直近で動いていれば、その間の位置をすべて含む範囲にする
    let l = Math.min(use.left, cur.left), t = Math.min(use.top, cur.top);
    let r2 = Math.max(use.left + use.width, cur.left + cur.width);
    let b2 = Math.max(use.top + use.height, cur.top + cur.height);
    return { draw: use, hole: { left: l, top: t, width: r2 - l, height: b2 - t } };
  }

  // screenVideo は startScreenCapture が返した video 要素をそのまま渡す
  function createComposer(screenVideo, camStream, opts) {
    const o = opts || {};
    const w = o.width || 720, h = o.height || 450, fps = o.fps || 5;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const sv = screenVideo || null;
    const areaEl  = o.areaEl || null;   // 録画してよい範囲
    const cropped = !!o.cropped;        // ブラウザ側で既に絞り込み済みか
    const getCalib = o.calib || null;   // 画面全体のときの「表示領域→映像」の対応
    const maskEl  = o.maskEl || null;   // 録画から除外する要素を返す関数
    const maskLag = o.maskLag == null ? 180 : o.maskLag;  // 映像が届くまでの遅れ（ミリ秒）
    const rectLog = [];                 // 除外範囲の履歴。遅れに合わせて少し前の位置を使う
    const paintMask = o.paintMask || null;  // 除外した場所に描き直す処理（任意）
    const cvid = camStream ? videoFrom(camStream) : null;
    let timer = null;

    /* 画面の描画。
       areaEl   : 録画してよい範囲（受験カード）
       cropped  : ブラウザ側で既に areaEl に絞り込み済みかどうか
       maskEl() : 録画から除外する要素（模範解答）。重ねて表示していても映らない

       除外はクリップで行うため、該当のピクセルは canvas に一度も描かれない。
       範囲や除外位置を特定できない場合は何も描かず、安全側に倒す。 */
    function drawScreen(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return;
      const iw = window.innerWidth || 0, ih = window.innerHeight || 0;
      if (!iw || !ih) return;

      // 画面全体を撮っている場合は、実測した対応で表示領域の位置を求める
      const cal = getCalib ? getCalib() : null;
      if (cal) {
        const toV2 = function (r) {
          return { x: cal.ox + r.left * cal.kx, y: cal.oy + r.top * cal.ky,
                   w: r.width * cal.kx, h: r.height * cal.ky };
        };
        const holes2 = [];
        const me2 = maskEl ? maskEl() : null;
        if (me2) {
          const cur = me2.getBoundingClientRect();
          if (!cur.width || !cur.height) return;
          const lag = laggedRect(rectLog, cur, maskLag);
          const mr = lag.hole, mr0 = lag.draw;
          const v = toV2(mr);
          const v0 = toV2(mr0);
          const s2 = Math.min(w / vw, h / vh);
          const dx2 = (w - vw * s2) / 2, dy2 = (h - vh * s2) / 2;
          const pad2 = (o.maskPad == null ? 22 : o.maskPad) * Math.min(cal.kx, cal.ky) * s2;
          holes2.push({ x: Math.round(dx2 + v.x * s2 - pad2), y: Math.round(dy2 + v.y * s2 - pad2),
                        w: Math.round(v.w * s2 + pad2 * 2), h: Math.round(v.h * s2 + pad2 * 2),
                        el: me2,
                        // 描き直し用。広げた分も余白も含まない実際の矩形
                        rect: { x: dx2 + v0.x * s2, y: dy2 + v0.y * s2, w: v0.w * s2, h: v0.h * s2 } });
        }
        const s2 = Math.min(w / vw, h / vh);
        const dw2 = vw * s2, dh2 = vh * s2;
        const dx2 = (w - dw2) / 2, dy2 = (h - dh2) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(dx2, dy2, dw2, dh2);
        for (let i = 0; i < holes2.length; i++) ctx.rect(holes2[i].x, holes2[i].y, holes2[i].w, holes2[i].h);
        ctx.clip('evenodd');
        ctx.drawImage(video, 0, 0, vw, vh, dx2, dy2, dw2, dh2);
        ctx.restore();
        if (holes2.length) {
          for (let i = 0; i < holes2.length; i++) {
            ctx.fillStyle = pickFill(ctx, w, h, holes2[i], o.maskFill);
            ctx.fillRect(holes2[i].x, holes2[i].y, holes2[i].w, holes2[i].h);
          }
          if (paintMask) {
            for (let i = 0; i < holes2.length; i++) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(holes2[i].x, holes2[i].y, holes2[i].w, holes2[i].h);
              ctx.clip();
              try { paintMask(ctx, holes2[i].rect || holes2[i], Math.min(cal.kx, cal.ky) * s2, holes2[i].el); } catch (e) {}
              ctx.restore();
            }
          }
        }
        return;
      }

      // 映像が写している範囲。絞り込み済みなら対象要素、そうでなければ表示領域全体
      let base, src;
      if (areaEl && cropped) {
        base = areaEl.getBoundingClientRect();
        if (!base.width || !base.height) return;
        src = { x: 0, y: 0, w: vw, h: vh };
      } else {
        base = { left: 0, top: 0, width: iw, height: ih };
        if (areaEl) {
          const er = areaEl.getBoundingClientRect();
          if (!er.width || !er.height) return;
          src = { x: (er.left) * (vw / iw), y: (er.top) * (vh / ih),
                  w: er.width * (vw / iw), h: er.height * (vh / ih) };
        } else {
          src = { x: 0, y: 0, w: vw, h: vh };
        }
      }
      const kx = vw / base.width, ky = vh / base.height;
      const toVideo = function (r) {
        return { x: (r.left - base.left) * kx, y: (r.top - base.top) * ky,
                 w: r.width * kx, h: r.height * ky };
      };

      const sx = Math.max(0, Math.floor(src.x));
      const sy = Math.max(0, Math.floor(src.y));
      const sw = Math.min(vw - sx, Math.ceil(src.w));
      const sh = Math.min(vh - sy, Math.ceil(src.h));
      if (sw <= 0 || sh <= 0) return;

      const s = Math.min(w / sw, h / sh);
      const dw = sw * s, dh = sh * s;
      const dx = (w - dw) / 2, dy = (h - dh) / 2;

      // 除外する矩形をキャンバス座標に直す（影の分だけ余白を足す）
      const holes = [];
      const me = maskEl ? maskEl() : null;
      if (me) {
        const cur = me.getBoundingClientRect();
        if (!cur.width || !cur.height) return;   // 位置を特定できない＝描かない
        const lag = laggedRect(rectLog, cur, maskLag);
        const mr = lag.hole, mr0 = lag.draw;
        const v = toVideo(mr);
        const v0 = toVideo(mr0);
        const pad = (o.maskPad == null ? 22 : o.maskPad) * Math.min(kx, ky) * s;
        holes.push({
          x: Math.round(dx + (v.x - sx) * s - pad),
          y: Math.round(dy + (v.y - sy) * s - pad),
          w: Math.round(v.w * s + pad * 2),
          h: Math.round(v.h * s + pad * 2),
          el: me,
          // 描き直し用。広げた分も余白も含まない実際の矩形
          rect: { x: dx + (v0.x - sx) * s, y: dy + (v0.y - sy) * s, w: v0.w * s, h: v0.h * s },
        });
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      for (let i = 0; i < holes.length; i++) {
        ctx.rect(holes[i].x, holes[i].y, holes[i].w, holes[i].h);
      }
      ctx.clip('evenodd');                      // 穴の部分には描かれない
      ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();

      // 抜いた場所は地色で埋め、必要なら呼び出し側に描き直してもらう
      if (holes.length) {
        for (let i = 0; i < holes.length; i++) {
          ctx.fillStyle = pickFill(ctx, w, h, holes[i], o.maskFill);
          ctx.fillRect(holes[i].x, holes[i].y, holes[i].w, holes[i].h);
        }
        if (paintMask) {
          for (let i = 0; i < holes.length; i++) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(holes[i].x, holes[i].y, holes[i].w, holes[i].h);
            ctx.clip();
            try { paintMask(ctx, holes[i].rect || holes[i], Math.min(kx, ky) * s, holes[i].el); } catch (e) {}
            ctx.restore();
          }
        }
      }
    }
    function draw() {
      ctx.fillStyle = '#0b1730';
      ctx.fillRect(0, 0, w, h);
      if (sv) drawScreen(sv);
      if (cvid && cvid.videoWidth) {
        const cw = Math.round(w * 0.22), ch = Math.round(cw * 0.75);
        const x = w - cw - 10, y = h - ch - 10;
        ctx.drawImage(cvid, x, y, cw, ch);   // 実像のまま描く（審査時に読めるように）
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, cw, ch);
      }
    }
    return {
      canvas: cv,                      // 確認用
      stream: cv.captureStream(fps),
      start: function () { draw(); timer = setInterval(draw, Math.round(1000 / fps)); },
      stop: function () {
        if (timer) clearInterval(timer);
        timer = null;
        removeVideo(cvid);   // 画面側の video は startScreenCapture の stop が片付ける
      },
      // 渡したストリームがすべて流れているか（空の録画や片方欠けを防ぐ）
      ready: function () {
        if (sv && !sv.videoWidth) return false;
        if (cvid && !cvid.videoWidth) return false;
        return !!(sv || cvid);
      },
    };
  }

  function extFor(mime) {
    return /mp4/.test(mime || '') ? 'mp4' : 'webm';
  }

  function createRecorder(stream, opts) {
    const o = opts || {};
    const mime = pickMime();
    if (!mime) throw new Error('この端末では録画できません');
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: o.bitrate || 150000,   // 低ビットレートで容量を抑える
    });
    const chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    return {
      mime: mime,
      start: function () { rec.start(2000); },
      stop: function () {
        return new Promise(function (resolve) {
          if (rec.state === 'inactive') { resolve(new Blob(chunks, { type: mime })); return; }
          rec.onstop = function () { resolve(new Blob(chunks, { type: mime })); };
          try { rec.requestData(); } catch (e) {}
          rec.stop();
        });
      },
      state: function () { return rec.state; },
    };
  }

  /* ---- 操作ログ ----
     記録するのは「受験者が何をしたか」だけです。
     模範解答の本文は渡されず、記録もされません。 */
  function createLogger() {
    const events = [];
    const t0 = Date.now();
    let last = '';
    return {
      startedAt: new Date(t0).toISOString(),
      // type: open / choice / code / paste / blur / focus / submit
      add: function (type, data) {
        const e = Object.assign({ t: Date.now() - t0, type: type }, data || {});
        events.push(e);
        return e;
      },
      // コード編集はスナップショットで記録（同じ内容は捨てる）
      snapshot: function (qid, text) {
        const v = String(text == null ? '' : text);
        if (v === last) return null;
        last = v;
        return this.add('code', { qid: qid, v: v });
      },
      resetSnapshot: function () { last = ''; },
      count: function () { return events.length; },
      bytes: function () { return JSON.stringify(events).length; },
      dump: function () { return events.slice(); },
    };
  }

  /* ---- Supabase Storage へのアップロード ---- */
  async function uploadRecording(blob, path) {
    const c = cfg();
    const base = String(c.SUPABASE_URL).replace(/\/+$/, '');
    const bucket = c.RECORDING_BUCKET || 'sc-recordings';
    let res;
    try {
      res = await fetch(base + '/storage/v1/object/' + bucket + '/' + path, {
        method: 'POST',
        headers: {
          'apikey': c.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + c.SUPABASE_ANON_KEY,
          'Content-Type': String(blob.type || 'application/octet-stream').split(';')[0],
          // x-upsert は付けない。上書き扱いになると INSERT に加えて UPDATE 権限が要るため。
          // ファイル名は毎回UUIDなので衝突しない。
          'Cache-Control': '3600',
        },
        body: blob,
      });
    } catch (e) {
      const err = new Error('ネットワークに接続できません');
      err.status = 0;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(function () { return ''; });
      const err = new Error(jaHttpError(res.status));
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return bucket + '/' + path;
  }

  /* ---- Supabase（未設定なら localStorage にフォールバック） ---- */
  function sbReady() {
    const c = cfg();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
  }

  // anon には SELECT 権限を与えていないため、INSERT結果の行を返させる指定は使えない。
  // id をこちら側で採番して INSERT のみで完結させる。
  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = '';
    for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }

  async function sbInsert(table, row) {
    const c = cfg();
    const base = String(c.SUPABASE_URL).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(base + '/rest/v1/' + table, {
        method: 'POST',
        headers: {
          'apikey': c.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + c.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(row),
      });
    } catch (e) {
      const err = new Error('ネットワークに接続できません');
      err.status = 0;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(function () { return ''; });
      const err = new Error(jaHttpError(res.status));
      err.status = res.status;
      err.body = body;       // 英文の詳細はコンソール確認用。画面には出さない
      throw err;
    }
    return row;
  }

  function localPush(key, row) {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push(row);
    localStorage.setItem(key, JSON.stringify(list));
    return row;
  }

  async function saveSession(row) {
    const full = Object.assign({ id: newId() }, row);
    if (sbReady()) { await sbInsert('sc_sessions', full); return full; }
    return localPush('sc_sessions', Object.assign({ created_at: new Date().toISOString() }, full));
  }

  async function saveResult(row) {
    const full = Object.assign({ id: newId() }, row);
    if (sbReady()) { await sbInsert('sc_results', full); return full; }
    return localPush('sc_results', Object.assign({ created_at: new Date().toISOString() }, full));
  }

  // 記述問題の解答（複数件をまとめて1回でINSERT）
  async function saveCodeAnswers(rows) {
    const full = rows.map(function (r) { return Object.assign({ id: newId() }, r); });
    if (!full.length) return [];
    if (sbReady()) { await sbInsert('sc_code_answers', full); return full; }
    full.forEach(function (r) {
      localPush('sc_code_answers', Object.assign({ created_at: new Date().toISOString() }, r));
    });
    return full;
  }

  async function saveLog(row) {
    const full = Object.assign({ id: newId() }, row);
    if (sbReady()) { await sbInsert('sc_logs', full); return full; }
    return localPush('sc_logs', Object.assign({ created_at: new Date().toISOString() }, full));
  }

  Object.assign(api, {
    detectCaps: detectCaps,
    closeCamera: closeCamera,
    sbReady: sbReady,
    newId: newId,
    saveSession: saveSession,
    saveResult: saveResult,
    saveCodeAnswers: saveCodeAnswers,
    saveLog: saveLog,
    canRecord: canRecord,
    pickMime: pickMime,
    listCameras: listCameras,
    openCameraStream: openCameraStream,
    screenCaptureSupport: screenCaptureSupport,
    startScreenCapture: startScreenCapture,
    calibrateScreen: calibrateScreen,
    removeMarks: removeMarks,
    createComposer: createComposer,
    extFor: extFor,
    createRecorder: createRecorder,
    createLogger: createLogger,
    uploadRecording: uploadRecording,
    bufToB64url: bufToB64url,
    b64urlToBuf: b64urlToBuf,
  });

  return api;
});
