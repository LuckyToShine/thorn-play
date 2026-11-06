// Thorn browser glue: the JS half of src/web.rs.
// A miniquad plugin; load after gl.js and audio.js, before load("thorn.wasm").
// Strings travel as UTF-8 bytes in wasm memory:
//   Rust -> JS: (ptr, len) arguments.
//   JS -> Rust: the call returns the byte length (-1 = None) and stages the
//   bytes; Rust allocates that many and calls thorn_read_out(ptr) to copy.
"use strict";

(function () {
    var canvas = document.getElementById("glcanvas");

    var enc = new TextEncoder(); // also turns lone surrogates into U+FFFD
    var dec = new TextDecoder("utf-8");
    var staged = null;
    function str(ptr, len) {
        return dec.decode(new Uint8Array(wasm_memory.buffer, ptr, len));
    }
    function ret(s) {
        if (s == null) { staged = null; return -1; }
        staged = enc.encode(s);
        return staged.length;
    }

    function el(tag, attrs, text) {
        var e = document.createElement(tag);
        for (var k in attrs) e.setAttribute(k, attrs[k]);
        if (text) e.textContent = text;
        return e;
    }

    // Keep keys, clipboard and drops inside our HTML widgets: gl.js listens on
    // the canvas (keys) and on window (paste/copy/cut/drop, which it
    // preventDefault()s, which would break pasting into the textarea).
    function isolate(node) {
        ["keydown", "keyup", "keypress", "paste", "copy", "cut", "drop", "dragover"]
            .forEach(function (t) {
                node.addEventListener(t, function (e) { e.stopPropagation(); });
            });
    }

    function refocusCanvas() {
        var a = document.activeElement;
        if (a && a !== canvas && a !== document.body && a.blur) a.blur();
        canvas.focus();
    }

    // ---------- styles (1-bit: black, white, monospace, square corners) ----------
    var style = el("style", {});
    style.textContent = [
        "#thorn-deck{position:fixed;inset:0;z-index:10;display:none;align-items:center;",
        "  justify-content:center;background:rgba(0,0,0,.75);padding:8px;box-sizing:border-box}",
        "#thorn-deck.open{display:flex}",
        "#thorn-deck .panel{background:#000;color:#fff;border:2px solid #fff;padding:16px;",
        "  width:100%;max-width:520px;max-height:100%;overflow:auto;box-sizing:border-box;",
        "  display:flex;flex-direction:column;gap:12px;outline:none}",
        "@font-face{font-family:Iosevka;src:url(IosevkaTerm-Regular.ttf)}",
        "#thorn-deck *,#thorn-text{font-family:Iosevka,monospace;font-size:16px;color:#fff;",
        "  background:#000;border-radius:0;box-sizing:border-box}",
        "#thorn-deck h2{margin:0;font-size:20px;font-weight:bold}",
        "#thorn-deck input[type=file]{width:100%;border:2px solid #fff;padding:6px}",
        "#thorn-deck input[type=file]::file-selector-button{font:inherit;color:#fff;",
        "  background:#000;border:2px solid #fff;border-radius:0;padding:4px 8px;margin-right:8px}",
        "#thorn-deck textarea{width:100%;min-height:140px;border:2px solid #fff;padding:6px;",
        "  resize:vertical}",
        "#thorn-deck textarea::placeholder{color:#fff;opacity:.6}",
        "#thorn-deck .row{display:flex;gap:12px}",
        "#thorn-deck button{flex:1;border:2px solid #fff;padding:10px;cursor:pointer}",
        "#thorn-deck button:focus-visible,#thorn-deck textarea:focus,",
        "  #thorn-deck input:focus-visible{outline:2px dashed #fff;outline-offset:2px}",
        "#thorn-deck button:active{background:#fff;color:#000}",
        "#thorn-deck .hint{margin:0}",
        "#thorn-deck .msg{margin:0}",
        "#thorn-deck .msg:empty{display:none}",
        "#thorn-text{position:fixed;z-index:10;display:none;border:2px solid #fff;",
        "  padding:0 6px;outline:none;margin:0}",
    ].join("\n");
    document.head.appendChild(style);

    // ---------- deck loader ----------
    var deckQueue = [];
    var taken = null; // submission being read by thorn_deck_take
    var deck = el("div", { id: "thorn-deck" });
    var panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true",
        "aria-labelledby": "thorn-deck-title", tabindex: "-1" });
    var title = el("h2", { id: "thorn-deck-title" }, "Load a deck");
    var file = el("input", { type: "file", accept: ".txt,.xml,.csv,.tsv",
        "aria-label": "Deck file" });
    var paste = el("textarea", { placeholder: "…or paste your questions here",
        "aria-label": "Paste questions", spellcheck: "false" });
    var row = el("div", { class: "row" });
    var loadBtn = el("button", { type: "button" }, "Load");
    var cancelBtn = el("button", { type: "button" }, "Cancel");
    var msg = el("p", { class: "msg", role: "alert" });
    var hint = el("p", { class: "hint" },
        "Formats: txt, xml, csv, tsv");
    row.append(loadBtn, cancelBtn);
    panel.append(title, file, paste, row, msg, hint);
    deck.appendChild(panel);
    isolate(deck);

    function deckIsOpen() { return deck.classList.contains("open"); }

    function deckOpen() {
        file.value = "";
        paste.value = "";
        msg.textContent = "";
        loadBtn.disabled = false;
        deck.classList.add("open");
        // Take focus off the canvas so keys stop reaching the game. Not the
        // textarea: on phones that would pop the keyboard over the dialog.
        panel.focus();
    }

    function deckClose() {
        if (!deckIsOpen()) return;
        deck.classList.remove("open");
        refocusCanvas();
    }

    function deckSubmit(name, text) {
        deckQueue.push({ name: name, text: text });
        deckClose();
    }

    loadBtn.addEventListener("click", function () {
        var f = file.files && file.files[0];
        if (f) {
            loadBtn.disabled = true;
            msg.textContent = "Reading " + f.name + "…";
            var reader = new FileReader();
            reader.onload = function () {
                loadBtn.disabled = false;
                if (String(reader.result).trim() === "") {
                    msg.textContent = "That file is empty.";
                    return;
                }
                deckSubmit(f.name, reader.result);
            };
            reader.onerror = function () {
                loadBtn.disabled = false;
                msg.textContent = "Could not read that file.";
            };
            reader.readAsText(f, "UTF-8");
        } else if (paste.value.trim() !== "") {
            deckSubmit(null, paste.value);
        } else {
            msg.textContent = "Choose a file or paste some questions first.";
        }
    });
    cancelBtn.addEventListener("click", deckClose);
    deck.addEventListener("keydown", function (e) {
        if (e.key === "Escape") deckClose();
    });

    // ---------- text input ----------
    var textQueue = [];
    var textEscape = false; // Escape pressed in the field, not yet taken
    var rect = null; // canvas-pixel rect while shown
    var text = el("input", { id: "thorn-text", type: "text", autocomplete: "off",
        autocorrect: "off", autocapitalize: "off", spellcheck: "false",
        enterkeyhint: "done", "aria-label": "Answer" });
    isolate(text);

    function placeText() {
        if (!rect) return;
        var r = canvas.getBoundingClientRect();
        var sx = r.width / (canvas.width || r.width || 1);
        var sy = r.height / (canvas.height || r.height || 1);
        var h = rect[3] * sy;
        text.style.left = (r.left + rect[0] * sx) + "px";
        text.style.top = (r.top + rect[1] * sy) + "px";
        text.style.width = (rect[2] * sx) + "px";
        text.style.height = h + "px";
        // >= 16px or iOS zooms the page when the field gets focus.
        text.style.fontSize = Math.max(16, Math.round(h * 0.55)) + "px";
    }

    text.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            textQueue.push(text.value);
        } else if (e.key === "Escape" && !e.isComposing) {
            e.preventDefault();
            textEscape = true;
        }
    });
    window.addEventListener("resize", placeText);

    document.body.append(deck, text);

    // ---------- audio ----------
    // macroquad's audio.js (quad-snd) creates its AudioContext in audio_init,
    // which runs at startup, before any user gesture: Chrome then warns and
    // keeps it suspended. So audio_init is deferred to the first gesture, and
    // every audio call is guarded: missing or broken audio must never stop
    // the game (a missing import would even fail instantiation).
    var AUDIO_DEFAULTS = {
        audio_init: undefined, audio_add_buffer: 0, audio_play_buffer: 0,
        audio_source_is_loaded: false, audio_source_set_volume: undefined,
        audio_source_stop: undefined, audio_source_delete: undefined,
        audio_playback_stop: undefined, audio_playback_set_volume: undefined,
    };
    var realAudioInit = null;
    var audioReady = false;
    function unlockAudio() {
        if (!audioReady && realAudioInit) {
            try { realAudioInit(); audioReady = true; }
            catch (e) { realAudioInit = null; console.warn("Thorn: no audio", e); }
        }
        // A gesture that doesn't count as activation (e.g. touchstart) leaves
        // it suspended; keep trying on later gestures.
        try {
            if (audioReady && audio_context && audio_context.state === "suspended") {
                audio_context.resume().catch(function () {});
            }
        } catch (e) { /* audio.js not loaded */ }
    }
    ["pointerdown", "pointerup", "mousedown", "touchend", "keydown", "click"]
        .forEach(function (t) { window.addEventListener(t, unlockAudio, true); });

    // Wrap the audio plugin's imports (call from register_plugin, after
    // audio.js registered). Until unlocked they do nothing.
    function guardAudio(env) {
        Object.keys(AUDIO_DEFAULTS).forEach(function (name) {
            var real = typeof env[name] === "function" ? env[name] : null;
            var fallback = AUDIO_DEFAULTS[name];
            if (name === "audio_init") {
                realAudioInit = real;
                env[name] = function () {}; // see unlockAudio
                return;
            }
            env[name] = function () {
                if (!real || !audioReady) return fallback;
                try { return real.apply(null, arguments); }
                catch (e) { return fallback; }
            };
        });
    }

    // ---------- plugin ----------
    function register_plugin(importObject) {
        var env = importObject.env;
        env.thorn_read_out = function (ptr) {
            if (staged) new Uint8Array(wasm_memory.buffer, ptr, staged.length).set(staged);
            staged = null;
        };
        env.thorn_storage_get = function (kp, kl) {
            try { return ret(window.localStorage.getItem(str(kp, kl))); }
            catch (e) { return ret(null); }
        };
        env.thorn_storage_set = function (kp, kl, vp, vl) {
            try { window.localStorage.setItem(str(kp, kl), str(vp, vl)); return 1; }
            catch (e) { return 0; }
        };
        env.thorn_deck_open = deckOpen;
        env.thorn_deck_close = deckClose;
        env.thorn_deck_is_open = function () { return deckIsOpen() ? 1 : 0; };
        // Moves the oldest submission into `taken`; Rust then reads its parts.
        env.thorn_deck_take = function () {
            taken = deckQueue.shift() || null;
            return taken ? 1 : 0;
        };
        env.thorn_deck_name = function () { return ret(taken && taken.name); };
        env.thorn_deck_text = function () {
            var t = taken ? taken.text : null;
            taken = null;
            return ret(t);
        };
        env.thorn_text_show = function (x, y, w, h) {
            rect = [x, y, w, h];
            text.value = "";
            textQueue = [];
            textEscape = false;
            text.style.display = "block";
            placeText();
            text.focus();
        };
        env.thorn_text_hide = function () {
            if (!rect) return;
            rect = null;
            text.style.display = "none";
            textQueue = [];
            textEscape = false;
            refocusCanvas();
        };
        env.thorn_text_place = function (x, y, w, h) {
            if (!rect) return;
            rect = [x, y, w, h];
            placeText();
        };
        env.thorn_text_take_escape = function () {
            var e = textEscape;
            textEscape = false;
            return e ? 1 : 0;
        };
        env.thorn_text_value = function () { return ret(rect ? text.value : ""); };
        env.thorn_text_take = function () {
            return ret(textQueue.length ? textQueue.shift() : null);
        };
        env.thorn_audio_unlocked = function () { return audioReady ? 1 : 0; };
        guardAudio(env);
        env.thorn_is_touch = function () {
            return (("ontouchstart" in window) || navigator.maxTouchPoints > 0) ? 1 : 0;
        };
    }

    miniquad_add_plugin({ register_plugin: register_plugin, name: "thorn_bridge", version: 1 });
})();
