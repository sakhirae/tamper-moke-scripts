// ==UserScript==
// @name         SpicyChat AI - Full Chat & Character Exporter
// @namespace    https://spicychat.ai/
// @version      1.0.1
// @description  Export your entire SpicyChat AI conversation + Character Profile (Avatar, Title, Greeting, Tags, Character Definition, Lorebooks), and deduplicated Images as a ZIP archive, Markdown, HTML, TXT, or JSON. Works on Firefox & Chrome.
// @author       Antigravity
// @match        https://spicychat.ai/*
// @match        https://*.spicychat.ai/*
// @grant        GM_xmlhttpRequest
// @connect      cdn.nd-api.com
// @connect      prod.nd-api.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const UI_ID = 'spicychat-exporter-root';

  // --- Capture SpicyChat API Auth Headers Passively (for 50+ message pagination fallback) ---
  const capturedAuth = {
    authorization: null,
    appId: 'spicychat',
  };

  try {
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const origFetch = pageWin.fetch;
    if (origFetch) {
      pageWin.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : input?.url || '';
          if (url.includes('nd-api.com') && init?.headers) {
            const h = init.headers;
            if (h instanceof Headers) {
              const auth = h.get('authorization') || h.get('Authorization');
              if (auth) capturedAuth.authorization = auth;
              const appId = h.get('x-app-id');
              if (appId) capturedAuth.appId = appId;
            } else if (typeof h === 'object') {
              for (const [k, v] of Object.entries(h)) {
                if (k.toLowerCase() === 'authorization' && v) capturedAuth.authorization = v;
                if (k.toLowerCase() === 'x-app-id' && v) capturedAuth.appId = v;
              }
            }
          }
        } catch {}
        return origFetch.apply(this, arguments);
      };
    }

    const origSetHeader = pageWin.XMLHttpRequest?.prototype?.setRequestHeader;
    if (origSetHeader) {
      pageWin.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          if (typeof name === 'string') {
            if (name.toLowerCase() === 'authorization' && value) {
              capturedAuth.authorization = value;
            } else if (name.toLowerCase() === 'x-app-id' && value) {
              capturedAuth.appId = value;
            }
          }
        } catch {}
        return origSetHeader.apply(this, arguments);
      };
    }
  } catch (e) {
    console.warn('[SpicyChat Exporter] Header hook note:', e);
  }

  // --- Pure JS ZIP Archive Builder (Zero external dependencies, CSP-safe) ---
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function createZipBlob(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    const now = new Date();
    const dosTime =
      ((now.getHours() & 0x1f) << 11) |
      ((now.getMinutes() & 0x3f) << 5) |
      ((now.getSeconds() >> 1) & 0x1f);
    const dosDate =
      (((now.getFullYear() - 1980) & 0x7f) << 9) |
      (((now.getMonth() + 1) & 0x0f) << 5) |
      (now.getDate() & 0x1f);

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data));
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, dataBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + size;
    }

    const centralSize = centralParts.reduce((acc, arr) => acc + arr.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  // --- Helper: Normalize SpicyChat CDN Image URLs ---
  function normalizeCdnUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed.split('?')[0];
    }
    const cleanPath = trimmed.replace(/^\/+/, '');
    return `https://cdn.nd-api.com/${cleanPath}`.split('?')[0];
  }

  // --- Helper: Fetch Binary Image Bytes & Detect File Extension ---
  function fetchImageBinary(url) {
    return new Promise((resolve) => {
      if (!url) {
        resolve(null);
        return;
      }

      const handleBlob = async (blob) => {
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          if (bytes.length === 0) return resolve(null);

          let ext = 'jpg';
          if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
            ext = 'png';
          } else if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
            ext = 'gif';
          } else if (
            bytes[0] === 0x52 &&
            bytes[1] === 0x49 &&
            bytes[2] === 0x46 &&
            bytes[3] === 0x46 &&
            bytes[8] === 0x57 &&
            bytes[9] === 0x45 &&
            bytes[10] === 0x42 &&
            bytes[11] === 0x50
          ) {
            ext = 'webp';
          } else if (blob.type.includes('png')) {
            ext = 'png';
          } else if (blob.type.includes('webp')) {
            ext = 'webp';
          } else if (blob.type.includes('gif')) {
            ext = 'gif';
          }

          resolve({ bytes, ext, mime: blob.type || `image/${ext}` });
        } catch {
          resolve(null);
        }
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 20000,
          onload: (resp) => {
            if (resp.status >= 200 && resp.status < 300 && resp.response) {
              handleBlob(resp.response);
            } else {
              resolve(null);
            }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } else {
        fetch(url, { mode: 'cors', credentials: 'omit' })
          .then((r) => (r.ok ? r.blob() : Promise.reject()))
          .then(handleBlob)
          .catch(() => resolve(null));
      }
    });
  }

  // --- Helper: Extract SpicyChat State Directly from React Fiber Tree ---
  function extractSpicyChatReactState() {
    const parts = (window.location.pathname.split('/chat/')[1] || '').split('/').filter(Boolean);
    const urlCharId = parts[0] || null;
    const urlConvId = parts[1] || null;

    if (!urlCharId) {
      throw new Error('Not on a SpicyChat conversation page. Open a character chat first!');
    }

    const scrollContainer =
      document.querySelector('.custom-scroll') ||
      document.querySelector('[class*="custom-scroll"]') ||
      document.body;

    const rawEl = scrollContainer.wrappedJSObject || scrollContainer;
    let fKey = Object.keys(rawEl).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );

    let startFiber = fKey ? rawEl[fKey] : null;

    if (!startFiber) {
      const allEls = document.querySelectorAll('div, main, section');
      for (const el of allEls) {
        const uw = el.wrappedJSObject || el;
        const k = Object.keys(uw).find((key) => key.startsWith('__reactFiber$'));
        if (k) {
          startFiber = uw[k];
          break;
        }
      }
    }

    if (!startFiber) {
      throw new Error('Could not locate React state on page. Make sure the chat is loaded.');
    }

    let rootFiber = startFiber;
    for (let i = 0; i < 6 && rootFiber.return; i++) {
      rootFiber = rootFiber.return;
    }

    let character = null;
    let conversation = null;
    let conversationLength = 0;
    let conversationId = urlConvId;
    let userName = null;
    let userAvatarUrl = null;
    let chatHeroData = null;
    let loadMessagesFn = null;

    const visited = new Set();

    function walk(fiber, depth) {
      if (!fiber || depth > 45 || visited.has(fiber)) return;
      visited.add(fiber);

      const props = fiber.memoizedProps;
      if (props && typeof props === 'object') {
        if (props.character && typeof props.character === 'object' && props.character.id) {
          if (!character || Object.keys(props.character).length > Object.keys(character).length) {
            character = props.character;
          }
        }
        if (Array.isArray(props.conversation)) {
          if (!conversation || props.conversation.length > conversation.length) {
            conversation = props.conversation;
          }
        }
        if (typeof props.conversationLength === 'number' && props.conversationLength > conversationLength) {
          conversationLength = props.conversationLength;
        }
        if (props.conversationId && !conversationId) {
          conversationId = props.conversationId;
        }
        if (props.currentConversationId && !conversationId) {
          conversationId = props.currentConversationId;
        }
        if (typeof props.user_name === 'string' && props.user_name.trim() && !userName) {
          userName = props.user_name.trim();
        }
        if (typeof props.user_avatar_url === 'string' && props.user_avatar_url && !userAvatarUrl) {
          userAvatarUrl = props.user_avatar_url;
        }
        if (props.chatHeroData && typeof props.chatHeroData === 'object' && !chatHeroData) {
          chatHeroData = props.chatHeroData;
        }
        if (typeof props.loadMessages === 'function' && !loadMessagesFn) {
          loadMessagesFn = props.loadMessages;
        }
      }

      walk(fiber.child, depth + 1);
      walk(fiber.sibling, depth + 1);
    }

    walk(rootFiber, 0);

    if (!character || !conversation) {
      let top = rootFiber;
      while (top.return) top = top.return;
      walk(top, 0);
    }

    if (!character && !conversation) {
      throw new Error('Could not find character or conversation data in page state.');
    }

    return {
      charId: character?.id || urlCharId,
      convId: conversationId || urlConvId,
      character: character ? JSON.parse(JSON.stringify(character)) : null,
      conversation: conversation ? JSON.parse(JSON.stringify(conversation)) : [],
      conversationLength,
      userName: userName || 'You',
      userAvatarUrl,
      chatHeroData: chatHeroData ? JSON.parse(JSON.stringify(chatHeroData)) : null,
      loadMessagesFn,
    };
  }

  // --- Helper: Fetch Full History if Conversation Has More Messages than Loaded ---
  async function ensureFullConversation(state, onStatus) {
    let messages = Array.isArray(state.conversation) ? [...state.conversation] : [];

    if (
      state.conversationLength > messages.length &&
      capturedAuth.authorization &&
      state.charId &&
      state.convId
    ) {
      try {
        if (onStatus) {
          onStatus(`⏳ Loading full chat history (${messages.length}/${state.conversationLength})...`);
        }
        const res = await fetch(
          `https://prod.nd-api.com/characters/${state.charId}/messages/${state.convId}?limit=1000&`,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: capturedAuth.authorization,
              'x-app-id': capturedAuth.appId || 'spicychat',
            },
          }
        );
        if (res.ok) {
          const data = await res.json();
          const apiMsgs = Array.isArray(data) ? data : data?.messages || data?.data || [];
          if (apiMsgs.length > messages.length) {
            messages = apiMsgs;
          }
        }
      } catch (e) {
        console.warn('[SpicyChat Exporter] API pagination fallback note:', e);
      }
    }

    messages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return messages;
  }

  function extractInlineImageUrls(text) {
    if (!text) return [];
    const urls = [];
    const mdRegex = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = mdRegex.exec(text)) !== null) {
      urls.push(m[1]);
    }
    const htmlRegex = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
    while ((m = htmlRegex.exec(text)) !== null) {
      urls.push(m[1]);
    }
    return urls;
  }

  function processInlineImagesInText(text, options, seenImageUrls) {
    if (!text) return '';
    let result = text;

    result = result.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (fullMatch, alt, url) => {
      if (!options.includeImages) return '';
      if (options.noRepeatImages) {
        if (seenImageUrls.has(url)) return '';
        seenImageUrls.add(url);
      }
      return fullMatch;
    });

    result = result.replace(/<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi, (fullMatch, url) => {
      if (!options.includeImages) return '';
      if (options.noRepeatImages) {
        if (seenImageUrls.has(url)) return '';
        seenImageUrls.add(url);
      }
      return fullMatch;
    });

    return result;
  }

  // --- Helper: Scrub User Persona Name in Text When "Include User Persona" is Unchecked ---
  function anonymizePersonaInText(text, rawPersonaName, options) {
    if (!text || options.includeUserPersona) return text;
    if (!rawPersonaName || rawPersonaName.toLowerCase() === 'you' || rawPersonaName.length < 2) {
      return text;
    }
    const escaped = rawPersonaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    return text.replace(/\{\{user\}\}/gi, 'You').replace(wordRegex, 'You');
  }

  // --- Helper: Normalize & Filter SpicyChat Data ---
  function parseSpicyChatData(state, rawMessages, options) {
    const char = state.character || {};
    const rawPersonaName = state.userName || 'You';
    const displayUserName = options.includeUserPersona ? rawPersonaName : 'You';
    const charName = (char.name || state.chatHeroData?.name || 'Character').trim();

    const avatarUrl =
      normalizeCdnUrl(char.avatar_url) ||
      normalizeCdnUrl(state.chatHeroData?.src) ||
      null;

    const seenImageUrls = new Set();
    if (avatarUrl && options.noRepeatImages) {
      seenImageUrls.add(avatarUrl);
    }

    const charInfo = {
      id: char.id || state.charId,
      name: charName,
      title: char.title || state.chatHeroData?.title || null,
      creatorName: char.creator_username || null,
      creatorId: char.creator_user_id || null,
      avatar: avatarUrl,
      tags: Array.isArray(char.tags) ? char.tags : state.chatHeroData?.tags || [],
      isNsfw: Boolean(char.is_nsfw),
      tokenCount: char.token_count || null,
      numMessages: char.num_messages || null,
      definitionVisible: Boolean(char.definition_visible),
      introduction: char.description || char.title || null,
      greeting: char.greeting
        ? anonymizePersonaInText(
            processInlineImagesInText(char.greeting, options, seenImageUrls),
            rawPersonaName,
            options
          )
        : null,
      personality: char.personality
        ? anonymizePersonaInText(char.personality, rawPersonaName, options)
        : null,
      scenario: char.scenario
        ? anonymizePersonaInText(char.scenario, rawPersonaName, options)
        : null,
      exampleConversation:
        char.example_dialogs || char.example_conversation || char.dialogue
          ? anonymizePersonaInText(
              char.example_dialogs || char.example_conversation || char.dialogue,
              rawPersonaName,
              options
            )
          : null,
      systemPrompt: char.system_prompt || null,
      lorebooks: Array.isArray(char.lorebooks) && char.lorebooks.length > 0 ? char.lorebooks : null,
      rulebook: char.rulebook || null,
    };

    const messages = [];
    for (const msg of rawMessages) {
      if (!msg) continue;
      const isUser = msg.role === 'user';
      let content = (msg.content || '').trim();

      if (options.filterContinue && isUser && content.toLowerCase() === 'continue') {
        continue;
      }

      content = processInlineImagesInText(content, options, seenImageUrls);
      content = anonymizePersonaInText(content, rawPersonaName, options);

      const images = [];
      if (options.includeImages) {
        const candidateImgUrls = [
          msg.image_url,
          msg.imageUrl,
          msg.media_url,
          ...(Array.isArray(msg.images) ? msg.images : []),
          ...(Array.isArray(msg.attachments) ? msg.attachments.map((a) => a?.url || a) : []),
        ]
          .map((u) => (typeof u === 'string' ? normalizeCdnUrl(u) : normalizeCdnUrl(u?.url)))
          .filter(Boolean);

        for (const imgUrl of candidateImgUrls) {
          if (options.noRepeatImages) {
            if (seenImageUrls.has(imgUrl)) continue;
            seenImageUrls.add(imgUrl);
          }
          images.push({
            url: imgUrl,
            keywords: msg.image_prompt || msg.prompt || 'generated image',
          });
        }
      }

      if (!content && images.length === 0) continue;

      messages.push({
        id: msg.id,
        role: isUser ? 'user' : 'character',
        speaker: isUser ? displayUserName : charName,
        content,
        timestamp: msg.createdAt || null,
        isoTime: msg.createdAt ? new Date(msg.createdAt).toISOString() : null,
        images,
      });
    }

    return {
      metadata: {
        platform: 'SpicyChat AI',
        characterId: state.charId,
        conversationId: state.convId,
        characterName: charName,
        characterTitle: charInfo.title ? `${charName} — ${charInfo.title}` : charName,
        speakingCharacterName: charName,
        userName: displayUserName,
        exportedAt: new Date().toISOString(),
        totalMessages: messages.length,
      },
      characterInfo: options.includeCharInfo ? charInfo : undefined,
      messages,
    };
  }

  // --- Helper: Collect & Download All Images for ZIP Export ---
  async function downloadAllImagesForZip(parsed, options, onProgress) {
    const items = [];
    const seen = new Set();

    const addUrl = (url, label) => {
      if (!url) return;
      if (options.noRepeatImages && seen.has(url)) return;
      seen.add(url);
      items.push({ url, label });
    };

    if (parsed.characterInfo) {
      addUrl(parsed.characterInfo.avatar, '00_character_avatar');
      extractInlineImageUrls(parsed.characterInfo.introduction).forEach((u, idx) =>
        addUrl(u, `00_intro_${idx + 1}`)
      );
      extractInlineImageUrls(parsed.characterInfo.greeting).forEach((u, idx) =>
        addUrl(u, `00_greeting_${idx + 1}`)
      );
    }

    parsed.messages.forEach((m, mIdx) => {
      const msgNum = String(mIdx + 1).padStart(3, '0');
      extractInlineImageUrls(m.content).forEach((u, iIdx) =>
        addUrl(u, `msg${msgNum}_inline_${iIdx + 1}`)
      );
      if (m.images) {
        m.images.forEach((img, iIdx) => {
          const safeKw = (img.keywords || `img_${iIdx + 1}`)
            .replace(/[^a-z0-9]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 35)
            .toLowerCase();
          addUrl(img.url, `msg${msgNum}_${safeKw}`);
        });
      }
    });

    const zipImageFiles = [];
    const urlToLocalPath = new Map();
    let done = 0;

    const batchSize = 4;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (item, bIdx) => {
          const globalIdx = i + bIdx + 1;
          const numPrefix = String(globalIdx).padStart(3, '0');
          const res = await fetchImageBinary(item.url);
          done++;
          if (onProgress) onProgress(done, items.length);

          if (res && res.bytes) {
            const filename = `images/${numPrefix}_${item.label}.${res.ext}`;
            zipImageFiles.push({ name: filename, data: res.bytes });
            urlToLocalPath.set(item.url, filename);
          }
        })
      );
    }

    zipImageFiles.sort((a, b) => a.name.localeCompare(b.name));
    return { zipImageFiles, urlToLocalPath };
  }

  function applyLocalImagePaths(parsed, urlToLocalPath) {
    const clone = JSON.parse(JSON.stringify(parsed));

    const replaceInText = (str) => {
      if (!str) return str;
      let out = str;
      for (const [remoteUrl, localPath] of urlToLocalPath.entries()) {
        out = out.split(remoteUrl).join(localPath);
      }
      return out;
    };

    if (clone.characterInfo) {
      if (clone.characterInfo.avatar && urlToLocalPath.has(clone.characterInfo.avatar)) {
        clone.characterInfo.avatar = urlToLocalPath.get(clone.characterInfo.avatar);
      }
      clone.characterInfo.introduction = replaceInText(clone.characterInfo.introduction);
      clone.characterInfo.greeting = replaceInText(clone.characterInfo.greeting);
    }

    for (const m of clone.messages) {
      m.content = replaceInText(m.content);
      if (m.images) {
        m.images = m.images.map((img) => ({
          ...img,
          originalUrl: img.url,
          url: urlToLocalPath.get(img.url) || img.url,
        }));
      }
    }

    return clone;
  }

  // --- Formatters ---
  function toMarkdown(parsed, options) {
    const { metadata, characterInfo, messages } = parsed;
    const lines = [];

    lines.push(`# ${metadata.characterTitle}`);
    lines.push(`**Character:** ${metadata.speakingCharacterName}  `);
    lines.push(`**You:** ${metadata.userName}  `);
    lines.push(`**Total Messages:** ${metadata.totalMessages}  `);
    lines.push(`**Exported:** ${new Date().toLocaleString()}  `);

    if (options.includeCharInfo && characterInfo) {
      lines.push('\n---\n');
      lines.push(`## 👤 Character Profile & Definition`);
      if (characterInfo.title) {
        lines.push(`- **Title / Tagline:** ${characterInfo.title}`);
      }
      if (characterInfo.creatorName) {
        lines.push(`- **Creator:** ${characterInfo.creatorName}`);
      }
      if (characterInfo.tokenCount) {
        lines.push(`- **Token Count:** ${characterInfo.tokenCount}`);
      }
      if (characterInfo.tags && characterInfo.tags.length > 0) {
        lines.push(`- **Tags:** ${characterInfo.tags.map((t) => `\`${t}\``).join(', ')}`);
      }

      if (options.includeImages && characterInfo.avatar) {
        lines.push(`\n### Profile Photo`);
        lines.push(`![Character Avatar](${characterInfo.avatar})`);
      }

      if (characterInfo.introduction && characterInfo.introduction !== characterInfo.title) {
        lines.push(`\n### 📖 Description`);
        lines.push(characterInfo.introduction);
      }

      if (characterInfo.greeting) {
        lines.push(`\n### 👋 Opening Greeting`);
        lines.push(characterInfo.greeting);
      }

      lines.push(`\n### ⚙️ Character Definition`);
      const hasDef =
        characterInfo.personality ||
        characterInfo.scenario ||
        characterInfo.exampleConversation ||
        characterInfo.systemPrompt;

      if (hasDef) {
        if (characterInfo.personality) lines.push(`**Personality:**\n${characterInfo.personality}\n`);
        if (characterInfo.scenario) lines.push(`**Scenario:**\n${characterInfo.scenario}\n`);
        if (characterInfo.systemPrompt) lines.push(`**System Prompt:**\n${characterInfo.systemPrompt}\n`);
        if (characterInfo.exampleConversation) {
          lines.push(`**Example Dialogue:**\n${characterInfo.exampleConversation}\n`);
        }
      } else {
        const visNote = !characterInfo.definitionVisible
          ? '*(Creator set Character Definition visibility to Private on SpicyChat AI)*'
          : '*(No separate Personality/Scenario fields; full setup is in the Greeting above)*';
        lines.push(visNote);
      }
    }

    lines.push('\n---\n');
    lines.push(`## 💬 Conversation History\n`);

    messages.forEach((m) => {
      const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      const header =
        m.role === 'user'
          ? `### 🧑 ${m.speaker} ${timeStr ? `*(${timeStr})*` : ''}`
          : `### 💬 ${m.speaker} ${timeStr ? `*(${timeStr})*` : ''}`;

      lines.push(header);
      lines.push('');
      lines.push(m.content);

      if (options.includeImages && m.images && m.images.length > 0) {
        lines.push('');
        m.images.forEach((img) => {
          lines.push(`![${img.keywords || 'Character Image'}](${img.url})`);
          lines.push(`*🖼️ ${img.keywords || 'Image'}*`);
          lines.push('');
        });
      }

      lines.push('\n---\n');
    });

    return lines.join('\n');
  }

  function toHtml(parsed, options) {
    const { metadata, characterInfo, messages } = parsed;

    const escapeHtml = (str) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const formatMessageText = (raw) => {
      if (!raw) return '';
      let s = escapeHtml(raw);
      s = s.replace(
        /!\[([^\]]*)\]\(([^)\s]+)\)/g,
        '<div style="margin:12px 0;"><img src="$2" alt="$1" style="max-width:100%;max-height:480px;border-radius:12px;border:1px solid rgba(255,255,255,0.15);display:block;" /></div>'
      );
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*\n]+)\*/g, '<em style="color:#cbd5e1;">$1</em>');
      s = s.replace(
        /`([^`\n]+)`/g,
        '<span style="background:rgba(249,115,22,0.18);color:#fed7aa;padding:2px 6px;border-radius:6px;font-family:monospace;font-size:0.92em;">💭 $1</span>'
      );
      return s.replace(/\n/g, '<br/>');
    };

    let charSectionHtml = '';
    if (options.includeCharInfo && characterInfo) {
      const hasDef =
        characterInfo.personality ||
        characterInfo.scenario ||
        characterInfo.exampleConversation ||
        characterInfo.systemPrompt;

      charSectionHtml = `
        <div class="char-card">
          <div class="char-header">
            ${
              options.includeImages && characterInfo.avatar
                ? `<img class="char-avatar" src="${characterInfo.avatar}" alt="Avatar" />`
                : ''
            }
            <div class="char-meta">
              <h1>${escapeHtml(characterInfo.name)}</h1>
              ${characterInfo.title ? `<div class="tagline">${escapeHtml(characterInfo.title)}</div>` : ''}
              <div class="sub">
                ${characterInfo.creatorName ? `<span>By <strong>${escapeHtml(characterInfo.creatorName)}</strong></span>` : ''}
                ${characterInfo.tokenCount ? `<span>• ${escapeHtml(characterInfo.tokenCount)} tokens</span>` : ''}
              </div>
              ${
                characterInfo.tags?.length
                  ? `<div class="tags">${characterInfo.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
                  : ''
              }
            </div>
          </div>

          ${
            characterInfo.greeting
              ? `<details class="collapsible" open><summary>👋 Opening Greeting</summary><div class="collapsible-body">${formatMessageText(characterInfo.greeting)}</div></details>`
              : ''
          }

          <details class="collapsible">
            <summary>⚙️ Character Definition</summary>
            <div class="collapsible-body">
              ${
                hasDef
                  ? `
                    ${characterInfo.personality ? `<p><strong>Personality:</strong><br/>${formatMessageText(characterInfo.personality)}</p>` : ''}
                    ${characterInfo.scenario ? `<p><strong>Scenario:</strong><br/>${formatMessageText(characterInfo.scenario)}</p>` : ''}
                    ${characterInfo.systemPrompt ? `<p><strong>System Prompt:</strong><br/>${formatMessageText(characterInfo.systemPrompt)}</p>` : ''}
                    ${characterInfo.exampleConversation ? `<p><strong>Example Dialogue:</strong><br/>${formatMessageText(characterInfo.exampleConversation)}</p>` : ''}
                  `
                  : `<em>${
                      !characterInfo.definitionVisible
                        ? 'Creator set Character Definition visibility to Private on SpicyChat AI.'
                        : 'No separate Personality/Scenario fields; full setup is in the Opening Greeting above.'
                    }</em>`
              }
            </div>
          </details>
        </div>
      `;
    }

    const messagesHtml = messages
      .map((m) => {
        const isUser = m.role === 'user';
        const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
        const imgsHtml =
          options.includeImages && m.images?.length
            ? `<div class="msg-images">${m.images
                .map(
                  (img) => `
                  <figure class="msg-img-card">
                    <img src="${img.url}" alt="${escapeHtml(img.keywords)}" loading="lazy" />
                    <figcaption>🖼️ ${escapeHtml(img.keywords)}</figcaption>
                  </figure>`
                )
                .join('')}</div>`
            : '';

        return `
          <div class="msg-row ${isUser ? 'user' : 'char'}">
            <div class="msg-bubble">
              <div class="msg-speaker">
                <strong>${escapeHtml(m.speaker)}</strong>
                <span>${escapeHtml(timeStr)}</span>
              </div>
              <div class="msg-content">${formatMessageText(m.content)}</div>
              ${imgsHtml}
            </div>
          </div>
        `;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(metadata.characterTitle)} - SpicyChat Export</title>
  <style>
    body {
      margin: 0;
      padding: 24px 16px 60px;
      background: #0b0b10;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
    }
    .container { max-width: 820px; margin: 0 auto; }
    .char-card {
      background: #14141d;
      border: 1px solid rgba(249, 115, 22, 0.35);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 28px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .char-header { display: flex; gap: 18px; align-items: center; margin-bottom: 16px; }
    .char-avatar {
      width: 96px; height: 96px; border-radius: 16px; object-fit: cover;
      border: 2px solid #f97316; flex-shrink: 0;
    }
    .char-meta h1 { margin: 0 0 4px; font-size: 22px; color: #fff; }
    .char-meta .tagline { font-size: 14px; color: #fdba74; margin-bottom: 6px; font-weight: 500; }
    .char-meta .sub { font-size: 13px; color: #9ca3af; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .tag {
      background: rgba(249, 115, 22, 0.16);
      border: 1px solid rgba(249, 115, 22, 0.4);
      color: #fed7aa; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    }
    .collapsible {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; margin-top: 10px; overflow: hidden;
    }
    .collapsible summary { padding: 10px 14px; cursor: pointer; font-weight: 600; color: #fed7aa; user-select: none; }
    .collapsible-body { padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 14px; }
    .msg-row { display: flex; margin-bottom: 16px; }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.char { justify-content: flex-start; }
    .msg-bubble {
      max-width: 82%; padding: 14px 18px; border-radius: 16px;
      background: #181824; border: 1px solid rgba(255,255,255,0.08);
    }
    .msg-row.user .msg-bubble {
      background: linear-gradient(135deg, rgba(234,88,12,0.32), rgba(225,29,72,0.28));
      border-color: rgba(249,115,22,0.45);
    }
    .msg-speaker {
      display: flex; justify-content: space-between; gap: 16px; font-size: 12px;
      color: #fdba74; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;
    }
    .msg-row.user .msg-speaker { color: #fda4af; }
    .msg-content { font-size: 15px; color: #f3f4f6; word-wrap: break-word; }
    .msg-images { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
    .msg-img-card { margin: 0; background: rgba(0,0,0,0.3); border-radius: 12px; padding: 8px; border: 1px solid rgba(255,255,255,0.08); }
    .msg-img-card img { max-width: 100%; max-height: 460px; border-radius: 8px; display: block; margin: 0 auto; }
    .msg-img-card figcaption { font-size: 11px; color: #9ca3af; text-align: center; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="container">
    ${charSectionHtml}
    ${messagesHtml}
  </div>
</body>
</html>`;
  }

  function toPlainText(parsed, options) {
    const { metadata, characterInfo, messages } = parsed;
    const lines = [];

    lines.push(`==================================================`);
    lines.push(`Character:       ${metadata.characterTitle}`);
    lines.push(`User:            ${metadata.userName}`);
    lines.push(`Messages:        ${metadata.totalMessages}`);
    lines.push(`Exported:        ${new Date().toLocaleString()}`);
    lines.push(`==================================================\n`);

    if (options.includeCharInfo && characterInfo) {
      lines.push(`--- CHARACTER PROFILE & DEFINITION ---`);
      if (characterInfo.title) lines.push(`Title: ${characterInfo.title}`);
      if (characterInfo.creatorName) lines.push(`Creator: ${characterInfo.creatorName}`);
      if (characterInfo.tags?.length) lines.push(`Tags: ${characterInfo.tags.join(', ')}`);
      if (options.includeImages && characterInfo.avatar) lines.push(`Avatar: ${characterInfo.avatar}`);
      if (characterInfo.greeting) {
        lines.push(`\n[Greeting]\n${characterInfo.greeting}`);
      }
      if (characterInfo.personality) lines.push(`\n[Personality]\n${characterInfo.personality}`);
      if (characterInfo.scenario) lines.push(`\n[Scenario]\n${characterInfo.scenario}`);
      if (characterInfo.exampleConversation) {
        lines.push(`\n[Example Dialogue]\n${characterInfo.exampleConversation}`);
      }
      lines.push(`\n==================================================\n`);
    }

    messages.forEach((m) => {
      const timeStr = m.timestamp ? `[${new Date(m.timestamp).toLocaleString()}] ` : '';
      lines.push(`${timeStr}${m.speaker}:`);
      lines.push(m.content);
      if (options.includeImages && m.images?.length) {
        m.images.forEach((img) => {
          lines.push(`[Image (${img.keywords}): ${img.originalUrl || img.url}]`);
        });
      }
      lines.push(`\n--------------------------------------------------\n`);
    });

    return lines.join('\n');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    downloadBlob(blob, filename);
  }

  // --- Build Discreet Floating UI ---
  function injectUI() {
    const old = document.getElementById(UI_ID);
    if (old) old.remove();

    const container = document.createElement('div');
    container.id = UI_ID;
    container.style.cssText = `
      position: fixed;
      bottom: 14px;
      right: 14px;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    container.innerHTML = `
      <style>
        #spicychat-exp-toggle {
          background: rgba(24, 24, 34, 0.72);
          backdrop-filter: blur(6px);
          color: rgba(255, 255, 255, 0.85);
          border: 1px solid rgba(249, 115, 22, 0.35);
          border-radius: 999px;
          padding: 6px 11px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
          margin-left: auto;
          opacity: 0.35;
          transition: opacity 0.2s ease, background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        }
        #spicychat-exp-toggle:hover,
        #spicychat-exp-toggle.active {
          opacity: 0.98;
          background: rgba(28, 25, 38, 0.95);
          border-color: rgba(249, 115, 22, 0.75);
          color: #fff;
          transform: translateY(-1px);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
        }
      </style>
      <div id="spicychat-exp-panel" style="
        display: none;
        background: rgba(18, 18, 24, 0.97);
        backdrop-filter: blur(12px);
        color: #f3f4f6;
        border: 1px solid rgba(249, 115, 22, 0.5);
        border-radius: 14px;
        padding: 14px;
        width: 300px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.65);
        margin-bottom: 8px;
        font-size: 13px;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:8px;">
          <strong style="color:#fed7aa;font-size:14px;">🌶️ SpicyChat Exporter v1.0</strong>
          <button id="spicychat-exp-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;">✕</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:12px;font-size:12px;color:#d1d5db;">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="spicychat-opt-charinfo" checked style="accent-color:#f97316;" />
            <span>Include Character Info & Definition</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="spicychat-opt-persona" style="accent-color:#f97316;" />
            <span>Include User Persona Name</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="spicychat-opt-images" checked style="accent-color:#f97316;" />
            <span>Include Images & Avatar</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;padding-left:18px;">
            <input type="checkbox" id="spicychat-opt-norepeat" checked style="accent-color:#ec4899;" />
            <span>No Repeat Images Filter</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="spicychat-opt-continue" checked style="accent-color:#f97316;" />
            <span>Hide bare "Continue" prompts</span>
          </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:7px;">
          <button data-fmt="zip-bundle" class="spicychat-dl-btn" style="background:linear-gradient(135deg,#ea580c,#e11d48);color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            📦 Download Full ZIP (MD + HTML + Images)
          </button>
          <button data-fmt="zip-images" class="spicychat-dl-btn" style="background:#27272a;color:#fb923c;border:1px solid rgba(249,115,22,0.5);padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            🖼️ Download Images Only (.zip)
          </button>
          <button data-fmt="md" class="spicychat-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #f97316;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            📄 Download Markdown (.md)
          </button>
          <button data-fmt="txt" class="spicychat-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #3f3f46;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:500;text-align:center;">
            📝 Download Plain Text (.txt)
          </button>
          <button data-fmt="json" class="spicychat-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #3f3f46;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:500;text-align:center;">
            🗂️ Download Full JSON (.json)
          </button>
        </div>

        <div id="spicychat-exp-status" style="margin-top:9px;font-size:11px;color:#fdba74;min-height:16px;text-align:center;"></div>
      </div>

      <button id="spicychat-exp-toggle" title="Export SpicyChat Conversation">
        <span style="font-size:12px;">📥</span> <span>Export</span>
      </button>
    `;

    document.body.appendChild(container);

    const panel = document.getElementById('spicychat-exp-panel');
    const toggleBtn = document.getElementById('spicychat-exp-toggle');
    const closeBtn = document.getElementById('spicychat-exp-close');
    const statusEl = document.getElementById('spicychat-exp-status');
    const imagesChk = document.getElementById('spicychat-opt-images');
    const noRepeatChk = document.getElementById('spicychat-opt-norepeat');

    imagesChk.addEventListener('change', () => {
      const enabled = imagesChk.checked;
      noRepeatChk.disabled = !enabled;
      noRepeatChk.parentElement.style.opacity = enabled ? '1' : '0.45';
    });

    toggleBtn.addEventListener('click', () => {
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      toggleBtn.classList.toggle('active', !isOpen);
    });

    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
      toggleBtn.classList.remove('active');
    });

    container.querySelectorAll('.spicychat-dl-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const format = btn.getAttribute('data-fmt');
        const options = {
          includeCharInfo:
            format === 'zip-images' ? true : document.getElementById('spicychat-opt-charinfo').checked,
          includeUserPersona: document.getElementById('spicychat-opt-persona').checked,
          includeImages:
            format === 'zip-images' ? true : document.getElementById('spicychat-opt-images').checked,
          noRepeatImages: document.getElementById('spicychat-opt-norepeat').checked,
          filterContinue: document.getElementById('spicychat-opt-continue').checked,
        };

        try {
          statusEl.style.color = '#fdba74';
          statusEl.textContent = '⏳ Extracting SpicyChat state...';

          const state = extractSpicyChatReactState();
          const rawMessages = await ensureFullConversation(state, (msg) => {
            statusEl.textContent = msg;
          });

          const parsed = parseSpicyChatData(state, rawMessages, options);

          const safeChar = (parsed.metadata.speakingCharacterName || 'character')
            .replace(/[^a-z0-9_\-]+/gi, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
          const dateTag = new Date().toISOString().slice(0, 10);

          if (format === 'zip-images') {
            statusEl.textContent = '🖼️ Downloading unique images for ZIP...';
            const { zipImageFiles } = await downloadAllImagesForZip(parsed, options, (done, total) => {
              statusEl.textContent = `🖼️ Downloading images (${done}/${total})...`;
            });
            if (zipImageFiles.length === 0) {
              throw new Error('No downloadable images found in this chat.');
            }
            const zipBlob = createZipBlob(zipImageFiles);
            downloadBlob(zipBlob, `spicychat_${safeChar}_images_${dateTag}.zip`);
            statusEl.style.color = '#4ade80';
            statusEl.textContent = `✅ Packed ${zipImageFiles.length} unique images into ZIP!`;
            return;
          }

          if (format === 'zip-bundle') {
            let zipFiles = [];
            let localParsed = parsed;

            if (options.includeImages) {
              statusEl.textContent = '🖼️ Downloading unique images for ZIP...';
              const { zipImageFiles, urlToLocalPath } = await downloadAllImagesForZip(
                parsed,
                options,
                (done, total) => {
                  statusEl.textContent = `🖼️ Downloading images (${done}/${total})...`;
                }
              );
              zipFiles = [...zipImageFiles];
              localParsed = applyLocalImagePaths(parsed, urlToLocalPath);
            }

            const encoder = new TextEncoder();
            zipFiles.unshift(
              { name: `chat_${safeChar}.md`, data: encoder.encode(toMarkdown(localParsed, options)) },
              { name: `chat_${safeChar}.html`, data: encoder.encode(toHtml(localParsed, options)) },
              { name: `chat_${safeChar}.txt`, data: encoder.encode(toPlainText(parsed, options)) },
              { name: `chat_${safeChar}.json`, data: encoder.encode(JSON.stringify(parsed, null, 2)) }
            );

            const zipBlob = createZipBlob(zipFiles);
            downloadBlob(zipBlob, `spicychat_${safeChar}_bundle_${dateTag}.zip`);
            statusEl.style.color = '#4ade80';
            statusEl.textContent = `✅ Exported ZIP (${parsed.metadata.totalMessages} msgs)!`;
            return;
          }

          if (format === 'md') {
            const md = toMarkdown(parsed, options);
            downloadFile(md, `spicychat_${safeChar}_${dateTag}.md`, 'text/markdown');
          } else if (format === 'txt') {
            const txt = toPlainText(parsed, options);
            downloadFile(txt, `spicychat_${safeChar}_${dateTag}.txt`, 'text/plain');
          } else {
            const jsonStr = JSON.stringify(parsed, null, 2);
            downloadFile(jsonStr, `spicychat_${safeChar}_${dateTag}.json`, 'application/json');
          }

          statusEl.style.color = '#4ade80';
          statusEl.textContent = `✅ Exported ${parsed.metadata.totalMessages} messages!`;
        } catch (err) {
          console.error('[SpicyChat Exporter]', err);
          statusEl.style.color = '#f87171';
          statusEl.textContent = `❌ ${err.message}`;
        }
      });
    });
  }

  function checkRoute() {
    if (!document.body) return;
    const isChatPage = /^\/chat\/[^/]+/.test(window.location.pathname);
    const existing = document.getElementById(UI_ID);
    if (isChatPage) {
      if (!existing) injectUI();
      else existing.style.display = 'block';
    } else if (existing) {
      existing.style.display = 'none';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkRoute);
  } else {
    checkRoute();
  }
  setInterval(checkRoute, 1500);
})();
