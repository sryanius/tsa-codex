/**
 * 침묵의 기록자 자료실 — Supabase 연결
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 용병단 게임의 `src/net/*` 을 가져다 쓰지 않고 따로 만들었다.
 * 두 프로젝트가 서로의 배포에 영향을 주지 않게 하려는 것이다 —
 * 같은 Supabase 프로젝트를 쓰지만 코드는 남남이다.
 *
 * ★ 여기 있는 두 값은 공개되는 것이 정상이다. 브라우저 코드에 그대로 실린다.
 *   방어선은 오직 RLS 와 비공개 버킷이다.
 *   · tsa-data (Storage) — 로그인한 사람만 읽는다
 *   · tsa_progress       — 본인 행만 읽고 쓴다
 *
 * ★ 클라우드가 죽어도 페이지는 떠야 한다. 데이터는 IndexedDB 에 캐시하고,
 *   네트워크가 없으면 캐시로 돈다. 이 계약이 깨지면 지하철에서 못 본다.
 */
(function () {
  "use strict";

  var URL_ = "https://peilvwrqgauwlaqojttq.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlaWx2d3JxZ2F1d2xhcW9qdHRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNTU0MTEsImV4cCI6MjEwMjczMTQxMX0.ks353ZYcf79woaMNBCRLo4W5tRJgGiYyJKjMT3PS0pM";
  var SESSION_KEY = "tsa_session_v1";
  var VERIFIER_KEY = "tsa_pkce_v1";
  var DB_NAME = "tsa-cache";
  var UID_KEY = "tsa_last_uid";

  /* ★ «이 사람의 것» 인 로컬 키. 계정이 바뀌면 비워야 한다.
   *   서버는 RLS 로 갈라져 있지만 브라우저는 안 갈라진다 — 여기서 갈라 준다.
   *   안 비우면 다음 사람이 앞사람 세이브를 보고, «올리기» 한 번에
   *   그 데이터가 그 사람 행으로 넘어간다 (퀘스트 화면은 버튼도 없이 자동으로 올린다).
   *   tsa.rep.v1 · tsa.showlocked.v1 은 개인 기록이 아니라 화면 설정이라 남긴다. */
  var LOCAL_KEYS = ["tsa.save.v1", "tsa.crew.v1", "tsa.qstate.v1", "tsa.levels.v1",
                    "tsa.fac.v1", "tsa.done.v1", "tsa.maps.v1", "tsa.fav.v1",
                    "tsa.simparty.v1", "tsa.simcrew.v1",    // 시뮬 — 저장한 파티 · 세이브 폴더에서 읽은 용병
                    "tsa.chestcrew.v1",                     // 금고 확률 — 용병별 도둑 레벨 · 통찰 · 재주(세이브 화면이 만든다)
                    "tsa.explored.v1"];                     // 지도 — 내가 연 칸 · 찾은 탐색지 · 탐색지 메모

  function wipeLocal() {
    for (var i = 0; i < LOCAL_KEYS.length; i++) {
      try { localStorage.removeItem(LOCAL_KEYS[i]); } catch (e) { }
    }
    try { indexedDB.deleteDatabase(DB_NAME); } catch (e) { }
  }

  /* ★ 데이터 판번호. build_cloud.py 가 full/*.json 과 mapimg 의 해시로 채워 넣는다.
   *   캐시 키 앞에 붙여서, 데이터를 새로 올리면 «기기에 남은 옛 캐시가 저절로 버려진다».
   *   이게 없던 동안 버킷은 새것인데 화면은 옛날 숫자인 상태가 조용히 유지됐다
   *   (특히 fetchBlob 은 캐시가 있으면 아예 다시 안 받아서 지도 배경이 영영 안 바뀐다). */
  var STAMP = "d3e5a993c6aa";
  function ck(k) { return STAMP + "|" + k; }

  /* ── 저장 헬퍼 ─────────────────────────────────────────────────────── */
  function ls(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { }
    return null;
  }

  /* ── IndexedDB 캐시 (2MB 넘는 데이터라 localStorage 로는 부족하다) ──── */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function cacheGet(k0) {
    var k = ck(k0);
    try {
      var db = await idb();
      return await new Promise(function (res) {
        var t = db.transaction("kv").objectStore("kv").get(k);
        t.onsuccess = function () { res(t.result || null); };
        t.onerror = function () { res(null); };
      });
    } catch (e) { return null; }
  }
  async function cachePut(k0, v) {
    var k = ck(k0);
    try {
      var db = await idb();
      await new Promise(function (res) {
        var t = db.transaction("kv", "readwrite").objectStore("kv").put(v, k);
        t.onsuccess = t.onerror = function () { res(); };
      });
    } catch (e) { }
  }

  /* 판이 바뀌면 옛 판의 캐시를 지운다. 안 지우면 IndexedDB 가 판마다 쌓인다. */
  async function cacheSweep() {
    try {
      var db = await idb();
      var st = db.transaction("kv", "readwrite").objectStore("kv");
      var req = st.getAllKeys();
      await new Promise(function (res) {
        req.onsuccess = function () {
          (req.result || []).forEach(function (k) {
            if (typeof k === "string" && k.indexOf(STAMP + "|") !== 0) st.delete(k);
          });
          res();
        };
        req.onerror = function () { res(); };
      });
    } catch (e) { }
  }

  /* ── PKCE ──────────────────────────────────────────────────────────── */
  function b64url(buf) {
    var s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function makeVerifier() {
    var a = new Uint8Array(64); crypto.getRandomValues(a);
    return b64url(a.buffer);
  }
  async function challengeOf(v) {
    return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  }
  function selfUrl() {
    var u = new URL(location.href); u.search = ""; u.hash = ""; return u.toString();
  }

  /* ── 세션 ──────────────────────────────────────────────────────────── */
  function session() { return ls(SESSION_KEY); }
  function saveSession(j) {
    if (!j || !j.access_token) return null;
    var s = {
      access: j.access_token, refresh: j.refresh_token || "",
      exp: Date.now() + (j.expires_in || 3600) * 1000,
      email: (j.user && j.user.email) || "",
      userId: (j.user && j.user.id) || ""
    };
    ls(SESSION_KEY, s); return s;
  }

  async function api(path, opt) {
    opt = opt || {};
    var s = session();
    var h = { apikey: ANON, "Content-Type": "application/json" };
    if (opt.auth !== false && s) h.Authorization = "Bearer " + s.access;
    if (opt.headers) for (var k in opt.headers) h[k] = opt.headers[k];
    var r = await fetch(URL_ + path, {
      method: opt.method || "GET", headers: h,
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    return r;
  }

  async function refresh() {
    var s = session();
    if (!s || !s.refresh) return null;
    var r = await api("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", auth: false, body: { refresh_token: s.refresh }
    });
    if (!r.ok) { ls(SESSION_KEY, null); return null; }
    return saveSession(await r.json());
  }
  async function ensureFresh() {
    var s = session();
    if (!s) return null;
    if (s.exp - Date.now() > 60000) return s;
    return await refresh();
  }

  window.TSA_CLOUD = {
    enabled: true,
    session: session,
    signedIn: function () { return !!session(); },
    email: function () { var s = session(); return s ? s.email : ""; },

    /** 구글 로그인 시작. 페이지를 떠난다. */
    signIn: async function (selectAccount) {
      var v = makeVerifier();
      ls(VERIFIER_KEY, v);
      var u = new URL(URL_ + "/auth/v1/authorize");
      u.searchParams.set("provider", "google");
      u.searchParams.set("redirect_to", selfUrl());
      u.searchParams.set("code_challenge", await challengeOf(v));
      u.searchParams.set("code_challenge_method", "s256");
      if (selectAccount) u.searchParams.set("prompt", "select_account");
      location.assign(u.toString());
    },

    /** 이 기기에 남은 개인 기록의 수. 로그아웃 확인 문구에 쓴다. */
    localTraces: function () {
      var k = 0;
      for (var i = 0; i < LOCAL_KEYS.length; i++) {
        try { if (localStorage.getItem(LOCAL_KEYS[i])) k++; } catch (e) { }
      }
      return k;
    },

    /** 클라우드에서 받은 «내 지도»(지도마다 연 칸 · 찾은 탐색지)를 이 기기에 둔다.
     *  force 가 거짓이면(페이지가 뜰 때 저절로) 이 기기 것보다 새것일 때만 바꾼다 —
     *  이 기기에서 방금 넣은 세이브를 올리기 전에 받은 옛 것으로 덮으면 안 된다.
     *  열린 지역 목록(tsa.maps.v1)도 같은 세이브에서 나온 것이라 같이 맞춘다. 바꿨으면 참. */
    adoptExplore: function (p, force) {
      var ex = p && p.explore;
      if (!ex || !ex.m) return false;
      var cur = ls("tsa.explored.v1");
      if (!force && cur && cur.at && !(String(ex.at || "") > String(cur.at))) return false;
      ls("tsa.explored.v1", ex);
      ls("tsa.maps.v1", Object.keys(ex.m));
      return true;
    },

    /**
     * 로그아웃. 기본은 «이 기기의 개인 기록까지» 지운다 —
     * 남기면 다음에 로그인한 사람이 앞사람 것을 보고 자기 행에 올려 버린다.
     * keepLocal 을 참으로 주면 세션만 끊는다.
     */
    signOut: function (keepLocal) {
      ls(SESSION_KEY, null);
      ls(VERIFIER_KEY, null);
      if (!keepLocal) { ls(UID_KEY, null); wipeLocal(); }
    },

    /**
     * 나는 자료 열람 명단(tsa_member)에 있나.
     * 버킷 읽기 정책이 명단을 보므로, 자료를 못 받았을 때 «왜» 를 여기서 가른다.
     * 정책이 «본인 행만» 이라 남이 명단에 누가 있는지는 못 본다.
     */
    isMember: async function () {
      var s = await ensureFresh();
      if (!s) return false;
      try {
        var r = await api("/rest/v1/tsa_member?select=user_id&user_id=eq." + s.userId);
        if (!r.ok) return false;
        return (await r.json()).length > 0;
      } catch (e) { return false; }
    },

    /** 로그인에서 돌아왔으면 코드를 토큰으로 바꾼다. 부팅 때 한 번 부른다. */
    completeOAuth: async function () {
      var url = new URL(location.href);
      var code = url.searchParams.get("code");
      var err = url.searchParams.get("error_description") || url.searchParams.get("error");
      var clean = function () {
        try {
          var u = new URL(location.href); u.search = ""; u.hash = "";
          history.replaceState(null, "", u.toString());
        } catch (e) { }
      };
      if (err) { clean(); return { ok: false, error: err }; }
      if (!code) return { ok: false, error: "", none: true };
      var v = ls(VERIFIER_KEY);
      clean();
      if (!v) return { ok: false, error: "로그인 정보를 잃었습니다. 다시 시도해 주세요." };
      var r = await api("/auth/v1/token?grant_type=pkce", {
        method: "POST", auth: false, body: { auth_code: code, code_verifier: v }
      });
      ls(VERIFIER_KEY, null);
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        var stale = j.error_code === "flow_state_not_found" || r.status === 404;
        return { ok: false, error: stale ? "로그인이 만료됐습니다. 다시 눌러 주세요." : (j.msg || j.error_description || "로그인 실패") };
      }
      saveSession(await r.json());
      return { ok: true, error: "" };
    },

    /**
     * 게임 데이터를 받는다. 캐시가 있으면 먼저 쓰고 뒤에서 갱신한다.
     * @param {string} name  'data.json' | 'codex.json'
     */
    fetchData: async function (name, onCached) {
      var cached = await cacheGet(name);
      if (cached && onCached) { try { onCached(cached); } catch (e) { } }
      /* ★ 자료(퀘스트·도감)는 로그인 없이도 받는다 — 버킷 읽기를 anon 에게 열어 뒀다
         (cloud/003_public_read.sql). 로그인이 필요한 것은 «내 기록»(tsa_progress)뿐이다.
         로그인했으면 그 토큰을, 아니면 공개 키를 그대로 쓴다. */
      var s = await ensureFresh();
      try {
        var r = await fetch(URL_ + "/storage/v1/object/tsa-data/" + name, {
          headers: { apikey: ANON, Authorization: "Bearer " + (s ? s.access : ANON) }
        });
        if (!r.ok) return cached;
        var j = await r.json();
        await cachePut(name, j);
        return j;
      } catch (e) { return cached; }
    },

    /**
     * 그림 같은 덩어리 파일 받기. 지도 배경이 이걸로 온다.
     * JSON 이 아니라 Blob 이므로 캐시도 Blob 째로 넣는다 —
     * IndexedDB 는 Blob 을 그대로 받아 준다.
     */
    fetchBlob: async function (name) {
      var key = "blob:" + name;
      var cached = await cacheGet(key);
      if (cached) return URL.createObjectURL(cached);
      var s = await ensureFresh();          /* 지도 배경도 로그인 없이 받는다 */
      try {
        var r = await fetch(URL_ + "/storage/v1/object/tsa-data/" + name, {
          headers: { apikey: ANON, Authorization: "Bearer " + (s ? s.access : ANON) }
        });
        if (!r.ok) return null;
        var b = await r.blob();
        await cachePut(key, b);
        return URL.createObjectURL(b);
      } catch (e) { return null; }
    },

    /**
     * 저장된 상태 받기.
     * payload 에는 세이브에서 뽑은 진행도(q)뿐 아니라
     * 손으로 넣은 값(시설 레벨·남은 의뢰·슬롯 수·수동 체크)도 함께 들어 있다.
     * 기기를 옮겨도 화면이 똑같이 보여야 하므로 한 덩어리로 다룬다.
     */
    getProgress: async function () {
      var s = await ensureFresh();
      // 조용히 null 을 돌려주면 «저장된 게 없다» 로 읽힌다.
      // 로그인이 끊긴 것과 아직 올린 적이 없는 것은 다른 사건이므로 갈라 놓는다.
      if (!s) throw new Error("로그인이 끊겼습니다. 다시 로그인해 주세요.");
      var r = await api("/rest/v1/tsa_progress?select=payload,saved_at&user_id=eq." + s.userId);
      if (!r.ok) throw new Error(r.status + " " + (await r.text().catch(function () { return ""; })).slice(0, 120));
      var rows = await r.json();
      if (!rows.length) return null;
      try {
        var p = JSON.parse(rows[0].payload);
        // 옛 형식(퀘스트 맵만 저장)도 읽어 준다
        if (p && !p.q && typeof p === "object") p = { q: p };
        p.at = rows[0].saved_at;
        return p;
      } catch (e) { return null; }
    },

    /** 상태 올리기 (upsert) */
    putProgress: async function (state) {
      var s = await ensureFresh();
      if (!s) return { ok: false, error: "로그인이 필요합니다" };
      var q = (state && state.q) || {};
      var cleared = 0, recorded = 0;
      for (var k in q) { recorded++; if (q[k].clear > 0) cleared++; }
      var now = new Date().toISOString();
      /* ★ 부르는 쪽마다 담아 오는 칸이 다르다 —
         퀘스트 화면은 {q,at,levels,fac,fav} 만 주고 crew·done 을 안 준다.
         예전에는 그걸 그대로 «비었다» 로 써서, 퀘스트 화면에서 별 하나만 눌러도
         클라우드의 용병 목록이 통째로 날아갔다. 혼자 써도 당하는 사고였다.
         그래서 **안 준 칸은 기존 값을 그대로 둔다.** */
      var prev = {};
      try {
        var pr = await api("/rest/v1/tsa_progress?select=payload&user_id=eq." + s.userId);
        if (pr.ok) {
          var rows0 = await pr.json();
          if (rows0.length) prev = JSON.parse(rows0[0].payload) || {};
        }
      } catch (e) { }
      function pick(k, dflt) {
        return Object.prototype.hasOwnProperty.call(state, k)
          ? state[k] : (Object.prototype.hasOwnProperty.call(prev, k) ? prev[k] : dflt);
      }
      var body = {
        user_id: s.userId,
        payload: JSON.stringify({
          q: q,
          at: state.at || prev.at || "",
          levels: pick("levels", {}),
          fac: pick("fac", null),
          done: pick("done", {}),
          crew: pick("crew", null),
          fav: pick("fav", null),     /* 담기만 하고 저장된 적이 없던 칸 */
          explore: pick("explore", null)   /* 도감 › 지도의 «내 지도» — 세이브 화면만 담아 온다 */
        }),
        saved_at: now, cleared: cleared, recorded: recorded, updated_at: now
      };
      var r = await api("/rest/v1/tsa_progress", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: [body]
      });
      if (!r.ok) {
        var t = "";
        try { t = (await r.text()).slice(0, 160); } catch (e) { }
        return { ok: false, error: r.status + " " + t };
      }
      return { ok: true, cleared: cleared, recorded: recorded };
    }
  };

  /* ★ 계정이 바뀌면 이 기기의 개인 기록을 비운다.
     로그아웃 버튼만으로는 모자라다 — refresh 가 한 번 실패하면(위 refresh() 의 !r.ok)
     세션이 «조용히» 날아가고 로컬 키는 남는다. 그 상태에서 다음 사람이 로그인하면
     앞사람 데이터를 보고, 퀘스트 화면의 자동 저장이 그것을 그 사람 행에 올려 버린다.
     처음 쓰는 기기(직전 uid 가 없음)에서는 비우지 않는다 — 기존 사용자가 잃으면 안 된다. */
  (function () {
    try {
      var s = session(), cur = s && s.userId, was = ls(UID_KEY);
      if (cur) {
        if (was && was !== cur) wipeLocal();
        if (was !== cur) ls(UID_KEY, cur);
      }
    } catch (e) { }
  })();

  cacheSweep();          /* 판이 바뀌었으면 옛 캐시를 여기서 버린다 */
})();
