// ==UserScript==
// @name         CrushOn AI - Full Chat & Character Exporter
// @namespace    https://crushon.ai/
// @version      2.2.0
// @description  Export your entire CrushOn AI conversation + Character Profile (Avatar, Title, Intro, Greeting, Character Definition), Memory Notes, and deduplicated Images as a ZIP archive, Markdown, HTML, TXT, or JSON. Works on Firefox & Chrome.
// @author       Antigravity
// @match        https://crushon.ai/*
// @grant        GM_xmlhttpRequest
// @connect      cdn.crushon.ai
// @connect      i.ibb.co
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const UI_ID = 'crushon-exporter-root';

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

  // --- Helper: Extract Character ID & Conversation ID ---
  async function resolveIds() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const charIdx = pathParts.indexOf('character');
    const characterId = charIdx !== -1 ? pathParts[charIdx + 1] : null;

    if (!characterId) {
      throw new Error('Not on a character chat page. Open a character chat first!');
    }

    let conversationId = null;
    const chatIdx = pathParts.indexOf('chat');
    if (chatIdx !== -1 && pathParts[chatIdx + 1]) {
      conversationId = pathParts[chatIdx + 1];
    }

    if (!conversationId) {
      const input = encodeURIComponent(
        JSON.stringify({ '0': { json: { characterId } } })
      );
      const res = await fetch(`/api/trpc/chat.listConversations?batch=1&input=${input}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        const convInfos = data?.[0]?.result?.data?.json?.conversationInfos || [];
        if (convInfos.length > 0 && convInfos[0]?.conversation?.id) {
          conversationId = convInfos[0].conversation.id;
        }
      }
    }

    if (!conversationId) {
      const sidebarLink = document.querySelector(`a[href*="/character/${characterId}/chat/"]`);
      if (sidebarLink) {
        const hrefParts = sidebarLink.getAttribute('href').split('?')[0].split('/');
        conversationId = hrefParts[hrefParts.length - 1];
      }
    }

    if (!conversationId) {
      throw new Error('Could not find an active conversationId for this character.');
    }

    return { characterId, conversationId };
  }

  // --- Helper: Fetch & Parse Character Info + Definition from RSC & __next_f ---
  async function fetchCharacterDetails(characterId) {
    const charInfo = {
      id: characterId,
      name: null,
      creatorName: null,
      creatorId: null,
      avatar: null,
      videoAvatar: null,
      sceneCardName: null,
      sceneCardImage: null,
      age: null,
      tags: [],
      introduction: null,
      greeting: null,
      definitionVisibility: null,
      personality: null,
      scenario: null,
      appearance: null,
      exampleConversation: null,
    };

    try {
      if (Array.isArray(window.__next_f)) {
        const textChunks = {};
        let pendingId = null;

        for (const item of window.__next_f) {
          if (!Array.isArray(item) || typeof item[1] !== 'string') continue;
          const str = item[1];

          const headerMatch = str.match(/^([0-9a-fA-F]+):T[0-9a-fA-F]+,([\s\S]*)$/);
          if (headerMatch) {
            const id = headerMatch[1];
            const rest = headerMatch[2];
            if (rest.length > 0) {
              textChunks[id] = rest;
              pendingId = null;
            } else {
              pendingId = id;
            }
            continue;
          }

          if (pendingId) {
            textChunks[pendingId] = str;
            pendingId = null;
            continue;
          }

          if (str.includes(`"id":"${characterId}"`) && str.includes('"character":{')) {
            const charObj = extractJsonObjectAfterKey(str, '"character":');
            if (charObj) {
              populateCharInfoFromObj(charInfo, charObj, textChunks);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[CrushOn Exporter] __next_f parse warning:', e);
    }

    try {
      const res = await fetch(`/character/${characterId}/details?from=ChatRoomScreen`, {
        headers: { RSC: '1' },
        credentials: 'include',
      });
      if (res.ok) {
        const rscText = await res.text();
        const rscChunks = parseRscStreamText(rscText);

        const charIdx = rscText.indexOf('"character":{');
        if (charIdx !== -1) {
          const charObj = extractJsonObjectAfterKey(rscText.slice(charIdx), '"character":');
          if (charObj) {
            populateCharInfoFromObj(charInfo, charObj, rscChunks);
          }
        }
      }
    } catch (e) {
      console.warn('[CrushOn Exporter] Details RSC fetch warning:', e);
    }

    return charInfo;
  }

  function parseRscStreamText(rawText) {
    const chunks = {};
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bytes = encoder.encode(rawText);

    const regex = /(?:^|\n|}|\]|")([0-9a-fA-F]+):T([0-9a-fA-F]+),/g;
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      const id = match[1];
      const byteLen = parseInt(match[2], 16);
      const startStrIdx = match.index + match[0].length;
      const prefixBytes = encoder.encode(rawText.slice(0, startStrIdx));
      const startByte = prefixBytes.length;
      if (byteLen > 0 && startByte + byteLen <= bytes.length) {
        chunks[id] = decoder.decode(bytes.slice(startByte, startByte + byteLen));
      }
    }
    return chunks;
  }

  function extractJsonObjectAfterKey(str, key) {
    const idx = str.indexOf(key);
    if (idx === -1) return null;
    const start = str.indexOf('{', idx + key.length);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < str.length; i++) {
      const ch = str[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(str.slice(start, i + 1));
            } catch {
              return null;
            }
          }
        }
      }
    }
    return null;
  }

  function resolveRef(val, chunkMap) {
    if (typeof val !== 'string') return val;
    if (val.startsWith('$')) {
      const refId = val.slice(1);
      if (chunkMap && chunkMap[refId]) return chunkMap[refId];
    }
    return val;
  }

  function populateCharInfoFromObj(target, obj, chunkMap) {
    if (!obj) return;
    target.name = obj.name || target.name;
    target.creatorName = obj.creator?.name || target.creatorName;
    target.creatorId = obj.creator?.id || obj.creator?.userId || target.creatorId;
    target.avatar = obj.avatar || obj.characterAvatar?.avatar || target.avatar;
    target.videoAvatar = obj.characterAvatar?.videoAvatar || target.videoAvatar;
    target.sceneCardName = obj.characterSceneCard?.name || target.sceneCardName;
    target.sceneCardImage = obj.characterSceneCard?.image || target.sceneCardImage;
    target.age = obj.age ?? target.age;

    if (Array.isArray(obj.tags) && obj.tags.length > 0) {
      target.tags = obj.tags.map((t) => (typeof t === 'string' ? t : t.label || t.slug)).filter(Boolean);
    }

    const intro = resolveRef(obj.description || obj.introduction, chunkMap);
    if (intro && !intro.startsWith('$')) target.introduction = intro;

    const greeting = resolveRef(obj.greeting, chunkMap);
    if (greeting && !greeting.startsWith('$')) target.greeting = greeting;

    if (obj.definitionVisibility !== undefined) {
      target.definitionVisibility = obj.definitionVisibility;
    }

    const personality = resolveRef(obj.personality, chunkMap);
    if (personality && !personality.startsWith('$')) target.personality = personality;

    const scenario = resolveRef(obj.scenario, chunkMap);
    if (scenario && !scenario.startsWith('$')) target.scenario = scenario;

    const appearance = resolveRef(obj.appearance, chunkMap);
    if (appearance && !appearance.startsWith('$')) target.appearance = appearance;

    const exampleConv = resolveRef(obj.example_conversation, chunkMap);
    if (exampleConv && !exampleConv.startsWith('$')) target.exampleConversation = exampleConv;
  }

  // --- Helper: Fetch Full History from CrushOn's tRPC API ---
  async function fetchFullConversation({ characterId, conversationId }) {
    const res = await fetch('/api/trpc/chat.getConversationV7WithHistory?batch=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        '0': {
          json: {
            characterId,
            conversationId,
            count: 9999,
          },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`API request failed with status ${res.status}`);
    }

    const payload = await res.json();
    const root = payload?.[0]?.result?.data?.json;
    if (!root || !root.historyData?.mapping) {
      throw new Error('Unexpected API response format (missing historyData.mapping).');
    }

    return root;
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

  // --- Helper: Parse Conversation & Apply Filters ---
  function parseConversation(root, charInfo, options) {
    const mapping = root.historyData.mapping || {};
    const convData = root.conversationData || {};
    const rawPersonaName = convData.profile?.name || 'You';
    const userName = options.includeUserPersona ? rawPersonaName : 'You';

    let speakingCharName = charInfo?.name || convData.sceneCard?.name || 'Character';
    const allNodes = Object.values(mapping).filter(Boolean);

    for (const node of allNodes) {
      if (node.role === 2 && typeof node.content === 'string') {
        const match = node.content.match(/^([A-Z][a-zA-Z0-9_\- ]{1,25}):\s*["“]/m);
        if (match && match[1]) {
          speakingCharName = match[1].trim();
          break;
        }
      }
    }

    if (charInfo) {
      charInfo.name = charInfo.name || speakingCharName;
      charInfo.sceneCardName = charInfo.sceneCardName || convData.sceneCard?.name || null;
      charInfo.sceneCardImage = charInfo.sceneCardImage || convData.sceneCard?.image || null;
    }

    const nodeMap = new Map();
    allNodes.forEach((n) => nodeMap.set(n.id, n));

    let latestNode = null;
    for (const n of allNodes) {
      if (!latestNode || (n.createdAt || 0) > (latestNode.createdAt || 0)) {
        latestNode = n;
      }
    }

    const activeChainIds = new Set();
    const activeChain = [];
    let curr = latestNode;
    while (curr && !activeChainIds.has(curr.id)) {
      activeChainIds.add(curr.id);
      activeChain.push(curr);
      curr = curr.parent ? nodeMap.get(curr.parent) : null;
    }
    activeChain.reverse();

    const orderedNodes =
      activeChain.length >= allNodes.length * 0.5
        ? activeChain
        : [...allNodes].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const seenImageUrls = new Set();

    const processedCharInfo = charInfo ? { ...charInfo } : null;
    if (processedCharInfo) {
      if (processedCharInfo.avatar && options.noRepeatImages) {
        seenImageUrls.add(processedCharInfo.avatar);
      }
      if (processedCharInfo.sceneCardImage && options.noRepeatImages) {
        seenImageUrls.add(processedCharInfo.sceneCardImage);
      }
      if (processedCharInfo.introduction) {
        processedCharInfo.introduction = processInlineImagesInText(
          processedCharInfo.introduction,
          options,
          seenImageUrls
        );
      }
      if (processedCharInfo.greeting) {
        processedCharInfo.greeting = processInlineImagesInText(
          processedCharInfo.greeting,
          options,
          seenImageUrls
        );
      }
    }

    const messages = [];
    for (const node of orderedNodes) {
      if (!node.content && (!node.extendedContents || node.extendedContents.length === 0)) {
        continue;
      }

      const isUser = node.role === 1;
      let content = (node.content || '').trim();

      if (options.filterContinue && isUser && content.toLowerCase() === 'continue') {
        continue;
      }

      content = processInlineImagesInText(content, options, seenImageUrls);

      const images = [];
      if (options.includeImages && Array.isArray(node.extendedContents)) {
        for (const ext of node.extendedContents) {
          const url = ext?.content?.emoticonExtendedContent?.url;
          const keywords = ext?.content?.emoticonExtendedContent?.keywords;
          if (url) {
            if (options.noRepeatImages) {
              if (seenImageUrls.has(url)) continue;
              seenImageUrls.add(url);
            }
            images.push({ url, keywords: keywords || 'scene image' });
          }
        }
      }

      messages.push({
        id: node.id,
        role: isUser ? 'user' : 'character',
        speaker: isUser ? userName : speakingCharName,
        content,
        timestamp: node.createdAt || null,
        isoTime: node.createdAt ? new Date(node.createdAt).toISOString() : null,
        model: node.channelName || node.channel || null,
        isEdited: Boolean(node.isEdited),
        images,
        summaryNote: options.includeMemory ? node.summarizationSoFar || null : null,
      });
    }

    return {
      metadata: {
        characterId: convData.conversation?.character_id || charInfo?.id,
        conversationId: convData.conversation?.id,
        characterTitle: charInfo?.name || speakingCharName,
        speakingCharacterName: speakingCharName,
        sceneName: convData.sceneCard?.name || null,
        userName,
        userBio: options.includeUserPersona ? convData.profile?.bio || null : null,
        createdAt: convData.conversation?.created_at
          ? new Date(convData.conversation.created_at).toISOString()
          : null,
        exportedAt: new Date().toISOString(),
        totalMessages: messages.length,
      },
      characterInfo: options.includeCharInfo ? processedCharInfo : undefined,
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
      if (parsed.characterInfo.sceneCardImage !== parsed.characterInfo.avatar) {
        addUrl(parsed.characterInfo.sceneCardImage, '00_scene_card');
      }
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
      if (clone.characterInfo.sceneCardImage && urlToLocalPath.has(clone.characterInfo.sceneCardImage)) {
        clone.characterInfo.sceneCardImage = urlToLocalPath.get(clone.characterInfo.sceneCardImage);
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
    if (metadata.speakingCharacterName && metadata.speakingCharacterName !== metadata.characterTitle) {
      lines.push(`**Character:** ${metadata.speakingCharacterName}  `);
    }
    if (metadata.sceneName) {
      lines.push(`**Scene:** ${metadata.sceneName}  `);
    }
    lines.push(`**You:** ${metadata.userName}  `);
    lines.push(`**Total Messages:** ${metadata.totalMessages}  `);
    lines.push(`**Exported:** ${new Date().toLocaleString()}  `);

    if (metadata.userBio) {
      lines.push(`\n> **Your Persona Bio:** ${metadata.userBio.replace(/\n/g, ' ')}`);
    }

    if (options.includeCharInfo && characterInfo) {
      lines.push('\n---\n');
      lines.push(`## 👤 Character Profile & Definition`);
      if (characterInfo.creatorName) {
        lines.push(`- **Creator:** ${characterInfo.creatorName}`);
      }
      if (characterInfo.age) {
        lines.push(`- **Age:** ${characterInfo.age}`);
      }
      if (characterInfo.tags && characterInfo.tags.length > 0) {
        lines.push(`- **Tags:** ${characterInfo.tags.map((t) => `\`${t}\``).join(', ')}`);
      }

      if (options.includeImages && characterInfo.avatar) {
        lines.push(`\n### Profile Photo`);
        lines.push(`![Character Avatar](${characterInfo.avatar})`);
      }
      if (
        options.includeImages &&
        characterInfo.sceneCardImage &&
        characterInfo.sceneCardImage !== characterInfo.avatar
      ) {
        lines.push(`\n### Scene Card Image (${characterInfo.sceneCardName || 'Scene'})`);
        lines.push(`![Scene Card](${characterInfo.sceneCardImage})`);
      }

      if (characterInfo.introduction) {
        lines.push(`\n### 📖 Introduction / Description`);
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
        characterInfo.appearance ||
        characterInfo.exampleConversation;

      if (hasDef) {
        if (characterInfo.personality) lines.push(`**Personality:**\n${characterInfo.personality}\n`);
        if (characterInfo.scenario) lines.push(`**Scenario:**\n${characterInfo.scenario}\n`);
        if (characterInfo.appearance) lines.push(`**Appearance:**\n${characterInfo.appearance}\n`);
        if (characterInfo.exampleConversation) {
          lines.push(`**Example Conversation:**\n${characterInfo.exampleConversation}\n`);
        }
      } else {
        const visNote =
          characterInfo.definitionVisibility === 2
            ? '*(Creator set Character Definition visibility to Private on CrushOn AI)*'
            : '*(No separate Personality/Scenario fields; full setup is in the Introduction & Greeting above)*';
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

      if (options.includeMemory && m.summaryNote) {
        lines.push('');
        lines.push(
          `<details><summary>🧠 Memory Summary at this point</summary>\n\n${m.summaryNote}\n\n</details>`
        );
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
        '<span style="background:rgba(168,85,247,0.18);color:#e9d5ff;padding:2px 6px;border-radius:6px;font-family:monospace;font-size:0.92em;">💭 $1</span>'
      );
      return s.replace(/\n/g, '<br/>');
    };

    let charSectionHtml = '';
    if (options.includeCharInfo && characterInfo) {
      const hasDef =
        characterInfo.personality ||
        characterInfo.scenario ||
        characterInfo.appearance ||
        characterInfo.exampleConversation;

      charSectionHtml = `
        <div class="char-card">
          <div class="char-header">
            ${
              options.includeImages && characterInfo.avatar
                ? `<img class="char-avatar" src="${characterInfo.avatar}" alt="Avatar" />`
                : ''
            }
            <div class="char-meta">
              <h1>${escapeHtml(metadata.characterTitle)}</h1>
              <div class="sub">
                ${characterInfo.creatorName ? `<span>By <strong>${escapeHtml(characterInfo.creatorName)}</strong></span>` : ''}
                ${characterInfo.age ? `<span>• Age: ${escapeHtml(characterInfo.age)}</span>` : ''}
                ${metadata.sceneName ? `<span>• Scene: ${escapeHtml(metadata.sceneName)}</span>` : ''}
              </div>
              ${
                characterInfo.tags?.length
                  ? `<div class="tags">${characterInfo.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
                  : ''
              }
            </div>
          </div>

          ${
            options.includeImages &&
            characterInfo.sceneCardImage &&
            characterInfo.sceneCardImage !== characterInfo.avatar
              ? `<details class="collapsible"><summary>🖼️ Scene Card Image (${escapeHtml(characterInfo.sceneCardName || 'Scene')})</summary><div class="collapsible-body"><img src="${characterInfo.sceneCardImage}" style="max-width:100%;max-height:420px;border-radius:12px;" /></div></details>`
              : ''
          }

          ${
            characterInfo.introduction
              ? `<details class="collapsible" open><summary>📖 Character Introduction / Bio</summary><div class="collapsible-body">${characterInfo.introduction}</div></details>`
              : ''
          }

          ${
            characterInfo.greeting
              ? `<details class="collapsible"><summary>👋 Opening Greeting</summary><div class="collapsible-body">${formatMessageText(characterInfo.greeting)}</div></details>`
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
                    ${characterInfo.appearance ? `<p><strong>Appearance:</strong><br/>${formatMessageText(characterInfo.appearance)}</p>` : ''}
                    ${characterInfo.exampleConversation ? `<p><strong>Example Dialogue:</strong><br/>${formatMessageText(characterInfo.exampleConversation)}</p>` : ''}
                  `
                  : `<em>${
                      characterInfo.definitionVisibility === 2
                        ? 'Creator set Character Definition visibility to Private on CrushOn AI.'
                        : 'No separate Personality/Scenario fields; full setup is in the Introduction & Greeting above.'
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

        const memHtml =
          options.includeMemory && m.summaryNote
            ? `<details class="memory-box"><summary>🧠 AI Memory Summary at this point</summary><div class="memory-body">${formatMessageText(m.summaryNote)}</div></details>`
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
              ${memHtml}
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
  <title>${escapeHtml(metadata.characterTitle)} - CrushOn Chat Export</title>
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
      border: 1px solid rgba(168, 85, 247, 0.35);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 28px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    .char-header { display: flex; gap: 18px; align-items: center; margin-bottom: 16px; }
    .char-avatar {
      width: 96px; height: 96px; border-radius: 16px; object-fit: cover;
      border: 2px solid #a855f7; flex-shrink: 0;
    }
    .char-meta h1 { margin: 0 0 6px; font-size: 22px; color: #fff; }
    .char-meta .sub { font-size: 13px; color: #9ca3af; display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; }
    .tag {
      background: rgba(168, 85, 247, 0.18);
      border: 1px solid rgba(168, 85, 247, 0.4);
      color: #e9d5ff; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    }
    .collapsible {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; margin-top: 10px; overflow: hidden;
    }
    .collapsible summary { padding: 10px 14px; cursor: pointer; font-weight: 600; color: #e9d5ff; user-select: none; }
    .collapsible-body { padding: 12px 14px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 14px; }
    .msg-row { display: flex; margin-bottom: 16px; }
    .msg-row.user { justify-content: flex-end; }
    .msg-row.char { justify-content: flex-start; }
    .msg-bubble {
      max-width: 82%; padding: 14px 18px; border-radius: 16px;
      background: #181824; border: 1px solid rgba(255,255,255,0.08);
    }
    .msg-row.user .msg-bubble {
      background: linear-gradient(135deg, rgba(126,34,206,0.35), rgba(219,39,119,0.28));
      border-color: rgba(219,39,119,0.45);
    }
    .msg-speaker {
      display: flex; justify-content: space-between; gap: 16px; font-size: 12px;
      color: #a78bfa; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 4px;
    }
    .msg-row.user .msg-speaker { color: #f472b6; }
    .msg-content { font-size: 15px; word-break: break-word; }
    .msg-images { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .msg-img-card {
      margin: 0; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px; overflow: hidden; max-width: 320px;
    }
    .msg-img-card img { display: block; width: 100%; height: auto; }
    .msg-img-card figcaption { padding: 6px 10px; font-size: 11px; color: #d1d5db; text-align: center; }
    .memory-box {
      margin-top: 12px; background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 8px; padding: 6px 10px; font-size: 12px;
    }
    .memory-box summary { cursor: pointer; color: #93c5fd; font-weight: 600; }
    .memory-body { margin-top: 8px; color: #dbeafe; }
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
    lines.push(`Character Title: ${metadata.characterTitle}`);
    lines.push(`Character Name:  ${metadata.speakingCharacterName}`);
    if (metadata.sceneName) lines.push(`Scene:           ${metadata.sceneName}`);
    lines.push(`User:            ${metadata.userName}`);
    lines.push(`Messages:        ${metadata.totalMessages}`);
    lines.push(`Exported:        ${new Date().toLocaleString()}`);
    lines.push(`==================================================\n`);

    if (options.includeCharInfo && characterInfo) {
      lines.push(`--- CHARACTER PROFILE & DEFINITION ---`);
      if (characterInfo.creatorName) lines.push(`Creator: ${characterInfo.creatorName}`);
      if (characterInfo.age) lines.push(`Age: ${characterInfo.age}`);
      if (characterInfo.tags?.length) lines.push(`Tags: ${characterInfo.tags.join(', ')}`);
      if (options.includeImages && characterInfo.avatar) lines.push(`Avatar: ${characterInfo.avatar}`);
      if (characterInfo.introduction) {
        lines.push(`\n[Introduction]\n${characterInfo.introduction.replace(/<[^>]+>/g, '').trim()}`);
      }
      if (characterInfo.greeting) {
        lines.push(`\n[Greeting]\n${characterInfo.greeting}`);
      }
      if (characterInfo.personality) lines.push(`\n[Personality]\n${characterInfo.personality}`);
      if (characterInfo.scenario) lines.push(`\n[Scenario]\n${characterInfo.scenario}`);
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
      if (options.includeMemory && m.summaryNote) {
        lines.push(`\n[Memory Summary]\n${m.summaryNote}`);
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

  // --- Build Floating UI ---
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
        #crushon-exp-toggle {
          background: rgba(20, 20, 28, 0.45);
          backdrop-filter: blur(6px);
          color: rgba(255, 255, 255, 0.75);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 11px;
          font-weight: 500;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 5px;
          margin-left: auto;
          opacity: 0.22;
          transition: opacity 0.2s ease, background 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
          box-shadow: none;
        }
        #crushon-exp-toggle:hover,
        #crushon-exp-toggle.active {
          opacity: 0.95;
          background: rgba(28, 25, 38, 0.9);
          border-color: rgba(168, 85, 247, 0.55);
          color: #fff;
          transform: translateY(-1px);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        }
      </style>
      <div id="crushon-exp-panel" style="
        display: none;
        background: rgba(18, 18, 24, 0.97);
        backdrop-filter: blur(12px);
        color: #f3f4f6;
        border: 1px solid rgba(168, 85, 247, 0.5);
        border-radius: 14px;
        padding: 14px;
        width: 300px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.65);
        margin-bottom: 8px;
        font-size: 13px;
      ">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:8px;">
          <strong style="color:#e9d5ff;font-size:14px;">📥 CrushOn Chat Exporter v2.2</strong>
          <button id="crushon-exp-close" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;">✕</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:12px;font-size:12px;color:#d1d5db;">
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="crushon-opt-charinfo" checked style="accent-color:#a855f7;" />
            <span>Include Character Info & Definition</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="crushon-opt-persona" style="accent-color:#a855f7;" />
            <span>Include User Persona (Name & Bio)</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="crushon-opt-images" checked style="accent-color:#a855f7;" />
            <span>Include Images</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;padding-left:18px;">
            <input type="checkbox" id="crushon-opt-norepeat" checked style="accent-color:#ec4899;" />
            <span>No Repeat Images Filter</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="crushon-opt-memory" checked style="accent-color:#a855f7;" />
            <span>Include AI Memory Notes</span>
          </label>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;">
            <input type="checkbox" id="crushon-opt-continue" checked style="accent-color:#a855f7;" />
            <span>Hide bare "Continue" prompts</span>
          </label>
        </div>

        <div style="display:flex;flex-direction:column;gap:7px;">
          <button data-fmt="zip-bundle" class="crushon-dl-btn" style="background:linear-gradient(135deg,#9333ea,#ec4899);color:#fff;border:none;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            📦 Download Full ZIP (MD + HTML + Images)
          </button>
          <button data-fmt="zip-images" class="crushon-dl-btn" style="background:#27272a;color:#f472b6;border:1px solid rgba(236,72,153,0.5);padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            🖼️ Download Images Only (.zip)
          </button>
          <button data-fmt="md" class="crushon-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #a855f7;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:600;text-align:center;">
            📄 Download Markdown (.md)
          </button>
          <button data-fmt="txt" class="crushon-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #3f3f46;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:500;text-align:center;">
            📝 Download Plain Text (.txt)
          </button>
          <button data-fmt="json" class="crushon-dl-btn" style="background:#27272a;color:#f3f4f6;border:1px solid #3f3f46;padding:8px 12px;border-radius:8px;cursor:pointer;font-weight:500;text-align:center;">
            🗂️ Download Full JSON (.json)
          </button>
        </div>

        <div id="crushon-exp-status" style="margin-top:9px;font-size:11px;color:#a78bfa;min-height:16px;text-align:center;"></div>
      </div>

      <button id="crushon-exp-toggle" title="Export CrushOn Chat">
        <span style="font-size:12px;">📥</span> <span>Export</span>
      </button>
    `;

    document.body.appendChild(container);

    const panel = document.getElementById('crushon-exp-panel');
    const toggleBtn = document.getElementById('crushon-exp-toggle');
    const closeBtn = document.getElementById('crushon-exp-close');
    const statusEl = document.getElementById('crushon-exp-status');
    const imagesChk = document.getElementById('crushon-opt-images');
    const noRepeatChk = document.getElementById('crushon-opt-norepeat');

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

    container.querySelectorAll('.crushon-dl-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const format = btn.getAttribute('data-fmt');
        const options = {
          includeCharInfo: document.getElementById('crushon-opt-charinfo').checked,
          includeUserPersona: document.getElementById('crushon-opt-persona').checked,
          includeImages:
            format === 'zip-images' ? true : document.getElementById('crushon-opt-images').checked,
          noRepeatImages: document.getElementById('crushon-opt-norepeat').checked,
          includeMemory: document.getElementById('crushon-opt-memory').checked,
          filterContinue: document.getElementById('crushon-opt-continue').checked,
        };

        try {
          statusEl.style.color = '#a78bfa';
          statusEl.textContent = '⏳ Fetching chat history & character info...';

          const ids = await resolveIds();
          const [rawRoot, charInfo] = await Promise.all([
            fetchFullConversation(ids),
            options.includeCharInfo || format === 'zip-images'
              ? fetchCharacterDetails(ids.characterId)
              : Promise.resolve(null),
          ]);

          const parsed = parseConversation(rawRoot, charInfo, options);

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
            downloadBlob(zipBlob, `crushon_${safeChar}_images_${dateTag}.zip`);
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
            downloadBlob(zipBlob, `crushon_${safeChar}_bundle_${dateTag}.zip`);
            statusEl.style.color = '#4ade80';
            statusEl.textContent = `✅ Exported ZIP (${parsed.metadata.totalMessages} msgs)!`;
            return;
          }

          if (format === 'md') {
            const md = toMarkdown(parsed, options);
            downloadFile(md, `crushon_${safeChar}_${dateTag}.md`, 'text/markdown');
          } else if (format === 'txt') {
            const txt = toPlainText(parsed, options);
            downloadFile(txt, `crushon_${safeChar}_${dateTag}.txt`, 'text/plain');
          } else {
            const jsonStr = JSON.stringify(parsed, null, 2);
            downloadFile(jsonStr, `crushon_${safeChar}_${dateTag}.json`, 'application/json');
          }

          statusEl.style.color = '#4ade80';
          statusEl.textContent = `✅ Exported ${parsed.metadata.totalMessages} messages!`;
        } catch (err) {
          console.error('[CrushOn Exporter]', err);
          statusEl.style.color = '#f87171';
          statusEl.textContent = `❌ ${err.message}`;
        }
      });
    });
  }

  function checkRoute() {
    const isChatPage = /^\/character\/[^/]+\/chat/.test(window.location.pathname);
    const existing = document.getElementById(UI_ID);
    if (isChatPage) {
      if (!existing) injectUI();
      else existing.style.display = 'block';
    } else if (existing) {
      existing.style.display = 'none';
    }
  }

  checkRoute();
  setInterval(checkRoute, 1500);
})();
