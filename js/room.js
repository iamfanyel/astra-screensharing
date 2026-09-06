'use strict';

/**
 * Room controller: wires signalling, the media mesh and the UI together.
 */
(function () {
  const LAYOUT_KEY = 'astra:layout';
  /**
   * A peer can publish a screen and a camera at once, so tiles are keyed by
   * both. Everything that walks or clears a peer's tiles iterates this list
   * rather than spelling the two suffixes out again.
   */
  const TILE_KINDS = ['screen', 'camera'];
  const tileKey = (id, kind) => id + ':' + kind;
  /** Long enough to read as a transition, short enough not to feel like a wait. */
  const LEAVE_DELAY_MS = 450;
  let leaving = false;
  let tornDown = false;
  const { AudioMixer, captureScreen, captureCamera, captureMicrophone, stopStream, QUALITY } =
    window.AstraMedia;

  const $ = (id) => document.getElementById(id);
  const el = {
    gate: $('gate'),
    gateForm: $('gate-form'),
    gateLoader: $('gate-loader'),
    gateTitle: $('gate-title'),
    gateSub: $('gate-sub'),
    gateName: $('gate-name'),
    gateSubmit: $('gate-submit'),
    gateError: $('gate-error'),
    gateAvatar: $('gate-avatar'),
    discordConnect: $('discord-connect'),
    discordConnected: $('discord-connected'),
    discordUsername: $('discord-username'),
    discordDisconnect: $('discord-disconnect'),
    avatarChange: $('avatar-change'),
    avatarFile: $('avatar-file'),
    avatarClear: $('avatar-clear'),
    topbar: $('topbar'),
    stage: $('stage'),
    sidebar: $('sidebar'),
    controls: $('controls'),
    grid: $('grid'),
    empty: $('empty'),
    roomCode: $('room-code'),
    copyLink: $('copy-link'),
    enableAudio: $('enable-audio'),
    people: $('people'),
    peoplePanel: $('people-panel'),
    chatPanel: $('chat-panel'),
    resizeX: $('resize-x'),
    resizeY: $('resize-y'),
    togglePeople: $('toggle-people'),
    toggleChat: $('toggle-chat'),
    toggleProfile: $('toggle-profile'),
    messages: $('messages'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    shareGroup: $('share-group'),
    share: $('share'),
    shareLabel: $('share-label'),
    shareOptions: $('share-options'),
    shareMenu: $('share-menu'),
    cameraGroup: $('camera-group'),
    cameraOptions: $('camera-options'),
    cameraMenu: $('camera-menu'),
    cameraDevicesList: $('camera-devices-list'),
    camera: $('camera'),
    cameraLabel: $('camera-label'),
    mic: $('mic'),
    micLabel: $('mic-label'),
    deafen: $('deafen'),
    deafenLabel: $('deafen-label'),
    systemAudio: $('system-audio'),
    systemAudioRow: $('system-audio-row'),
    fluidity: $('fluidity'),
    fluidityRow: $('fluidity-row'),
    quality: $('quality'),
    qualityVal: $('quality-val'),
    qualityWrap: $('quality-wrap'),
    qualityTrigger: $('quality-trigger'),
    qualityDropdown: $('quality-dropdown'),
    status: $('status'),
    leave: $('leave'),
    closed: $('closed'),
    closedReason: $('closed-reason'),
    backToStart: $('back-to-start'),
    leaving: $('leaving'),
    toasts: $('toasts'),
    profilePopup: $('profile-popup'),
    profilePopupBackdrop: $('profile-popup-backdrop'),
    profilePopupCard: $('profile-popup-card'),
    profilePopupClose: $('profile-popup-close'),
    profilePopupBanner: $('profile-popup-banner'),
    profilePopupAvatar: $('profile-popup-avatar'),
    profilePopupUserBadges: $('profile-popup-user-badges'),
    profilePopupName: $('profile-popup-name'),
    profilePopupBadges: $('profile-popup-badges'),
    profilePopupDiscord: $('profile-popup-discord'),
    profilePopupDiscordUser: $('profile-popup-discord-user'),
    profilePopupVolumeSection: $('profile-popup-volume-section'),
    profilePopupVolumeVal: $('profile-popup-volume-val'),
    profilePopupVolumeMute: $('profile-popup-volume-mute'),
    profilePopupVolumeSlider: $('profile-popup-volume-slider'),
    profilePopupEditBtn: $('profile-popup-edit-btn'),
    profilePopupKickBtn: $('profile-popup-kick-btn'),
    profileModal: $('profile-modal'),
    profileModalBackdrop: $('profile-modal-backdrop'),
    profileModalClose: $('profile-modal-close'),
    profileModalBanner: $('profile-modal-banner'),
    bannerChangeBtn: $('banner-change-btn'),
    bannerClearBtn: $('banner-clear-btn'),
    bannerFile: $('banner-file'),
    profileModalAvatar: $('profile-modal-avatar'),
    profileModalUserBadges: $('profile-modal-user-badges'),
    profileAvatarChange: $('profile-avatar-change'),
    profileAvatarClear: $('profile-avatar-clear'),
    profileAvatarFile: $('profile-avatar-file'),
    profileModalName: $('profile-modal-name'),
    profileModalDiscord: $('profile-modal-discord'),
    profileModalDiscordUser: $('profile-modal-discord-user'),
    profileModalSave: $('profile-modal-save'),
    themeHue: $('theme-hue'),
    themeReset: $('theme-reset'),
  };

  const params = new URLSearchParams(location.search);
  const wantsCreate = params.has('create');
  const roomCode = (params.get('room') || '').trim().toUpperCase();

  if (!wantsCreate && !window.ASTRA.roomCodePattern.test(roomCode)) {
    location.replace('../');
    return;
  }

  const state = {
    signal: null,
    mesh: null,
    mixer: null,
    localStream: null, // what we publish: mixed audio + (optionally) a video track
    videoStream: null, // the raw capture, kept so we can stop its tracks
    videoTrack: null,
    cameraStream: null,
    cameraTrack: null,
    micStream: null,
    sharing: false,
    cameraOn: false,
    cameraDeviceId: (() => {
      try { return localStorage.getItem('astra:camera-device') || null; } catch (_) { return null; }
    })(),
    micOn: false,
    deafened: false,
    remote: new Map(), // peer id -> MediaStream
    remoteVideoTracks: new Map(), // peer id -> Set<MediaStreamTrack>
    tiles: new Map(), // tile key -> { slot, root, video, label, ... }
    audios: new Map(), // peer id -> HTMLAudioElement
    speakingPeers: new Set(), // peer IDs currently speaking
    peopleAvatars: new Map(), // peer id -> HTML element (.avatar)
    peopleRows: new Map(), // peer id -> { item, avatar, name, tags, ... }
    peerVolumes: new Map(), // peer id -> { volume: 1.0, muted: false }
    peerWatching: new Map(), // peer id -> boolean
    focused: null,
  };

  // ---------------------------------------------------------------- the gate

  el.gateName.value = AstraProfile.getName();
  if (wantsCreate) {
    el.gateTitle.textContent = 'New room';
    el.gateSub.textContent = 'You will get a code to share once the room is open.';
    el.gateSubmit.textContent = 'Create room';
    document.title = 'New room — Astra';
  } else {
    el.gateSub.textContent = 'Joining room ' + roomCode + '.';
    document.title = roomCode + ' — Astra';
  }

  // The signalling library comes from a CDN; say so plainly if it never arrived.
  if (typeof Peer === 'undefined') {
    el.gateSubmit.disabled = true;
    el.gateError.textContent =
      'Could not load the connection library. Check your network or any content blocker, then reload.';
    el.gateError.hidden = false;
  }

  async function checkRoomStatus(code) {
    if (!code) return null;
    try {
      const res = await fetch('/api/room?code=' + encodeURIComponent(code));
      if (!res.ok) return { exists: true, fallback: true };
      return await res.json();
    } catch (_) {
      return { exists: true, fallback: true };
    }
  }

  function notifyRoomApi(action, code, peerCount) {
    if (!code) return;
    try {
      fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, code, peerCount }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  let roomApiHeartbeatInterval = null;

  function startRoomApiHeartbeat(code) {
    stopRoomApiHeartbeat();
    // Only the room host (hub) needs to send periodic heartbeats.
    // Non-host peers sending heartbeats creates redundant KV writes and rapidly exhausts free tier quotas.
    if (!state.signal || !state.signal.isHub) return;

    const count = state.signal && state.signal.roster ? state.signal.roster.size : 1;
    notifyRoomApi('heartbeat', code, count);
    roomApiHeartbeatInterval = setInterval(() => {
      if (tornDown || leaving || !state.signal || state.signal.left || !state.signal.isHub) {
        stopRoomApiHeartbeat();
        return;
      }
      const peerCount = state.signal.roster ? state.signal.roster.size : 1;
      notifyRoomApi('heartbeat', code, peerCount);
    }, 60000);
  }

  function stopRoomApiHeartbeat() {
    if (roomApiHeartbeatInterval) {
      clearInterval(roomApiHeartbeatInterval);
      roomApiHeartbeatInterval = null;
    }
  }

  let exitBeaconSent = false;
  function sendRoomExitBeacon() {
    if (exitBeaconSent || !state.signal || !state.signal.code) return;
    exitBeaconSent = true;
    const code = state.signal.code;
    const rosterSize = state.signal.roster ? state.signal.roster.size : 1;
    // Only the host or the last member leaving needs to signal room vacancy.
    if (!state.signal.isHub && rosterSize > 1) return;
    const action = rosterSize <= 1 ? 'empty' : 'leave';
    const payload = JSON.stringify({ action, code, peerCount: Math.max(0, rosterSize - 1) });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/room', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }

  // Pre-check room status on load; only auto-redirect if the room was explicitly marked expired
  const roomStatusPromise = roomCode && !wantsCreate ? checkRoomStatus(roomCode) : null;
  if (roomStatusPromise) {
    roomStatusPromise.then((status) => {
      if (status && !status.fallback && status.expired) {
        location.replace('../?deleted=1');
      }
    });
  }

  el.gateForm.addEventListener('submit', (event) => {
    event.preventDefault();
    startSession(AstraProfile.setName(el.gateName.value) || 'Guest');
  });

  async function startSession(name) {
    if (typeof Peer === 'undefined') return;

    el.gateSubmit.disabled = true;
    el.gateError.hidden = true;
    setGateLoading(true);

    try {
      let roomStatus = null;
      if (!wantsCreate && roomCode) {
        roomStatus = await (roomStatusPromise || checkRoomStatus(roomCode));
        if (roomStatus && !roomStatus.fallback && roomStatus.expired) {
          location.replace('../?deleted=1');
          return;
        }
      }

      state.mixer = new AudioMixer();
      await state.mixer.resume();

      if (wantsCreate) {
        state.signal = await Signal.create(name);
      } else if (roomStatus && roomStatus.needsHost) {
        state.signal = await Signal.reclaim(roomCode, name);
      } else {
        try {
          state.signal = await Signal.join(roomCode, name);
        } catch (err) {
          // If no host responded (host closed tab or tab refresh):
          // Only reclaim if the room is still within the 5-minute valid window
          const canReclaim = !roomStatus || (!roomStatus.expired && roomStatus.exists !== false);
          if (err && err.type === 'peer-unavailable' && canReclaim) {
            try {
              state.signal = await Signal.reclaim(roomCode, name);
            } catch (_) {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }

      enterRoom();
    } catch (err) {
      console.error(err);
      if (state.mixer) {
        state.mixer.close();
        state.mixer = null;
      }
      const msg = friendlyError(err);
      if (
        (err && (err.type === 'peer-unavailable' || err.type === 'room-deleted')) ||
        msg.toLowerCase().includes('expired') ||
        msg.toLowerCase().includes('no room')
      ) {
        location.replace('../?deleted=1');
        return;
      }
      // Fall back to asking, so a failure is always recoverable.
      setGateLoading(false);
      el.gateError.textContent = msg;
      el.gateError.hidden = false;
      el.gateSubmit.disabled = false;
      el.gateSubmit.textContent = wantsCreate ? 'Create room' : 'Join';
    }
  }

  // Coming from the landing page the name and picture are already chosen, so
  // asking again on a second screen would just repeat it: open the room now.
  // A bare invite link has no `go` flag and still gets the gate.
  // The pre-script in room/index.html already made this call and showed the loader.
  if (document.documentElement.dataset.autostart === '1' && typeof Peer !== 'undefined') {
    setGateLoading(true);
    startSession(AstraProfile.getName() || 'Guest');
  }

  // That path carries no user gesture of its own, and an AudioContext will not
  // start without one - so take the first interaction in the room instead.
  const wakeAudio = () => {
    if (!state.mixer) return;
    state.mixer.resume();
    // Once the graph is running there is nothing left for this to do.
    if (state.mixer.ctx.state === 'running') {
      document.removeEventListener('pointerdown', wakeAudio);
      document.removeEventListener('keydown', wakeAudio);
    }
  };
  document.addEventListener('pointerdown', wakeAudio);
  document.addEventListener('keydown', wakeAudio);

  // ------------------------------------------------------------- profile

  function profileError(message) {
    if (state.signal) return toast(message, 'bad');
    el.gateError.textContent = message;
    el.gateError.hidden = false;
  }

  const picker = AstraProfile.mountPicker({
    nameInput: el.gateName,
    avatarEl: el.gateAvatar,
    changeBtn: el.avatarChange,
    fileInput: el.avatarFile,
    clearBtn: el.avatarClear,
    // Already in the room? Everyone else needs to see the new picture too.
    onChange: (dataUrl) => {
      if (!state.signal) return;
      state.signal.setState({ avatar: dataUrl });
      renderPeople();
    },
    onError: profileError,
  });

  if (window.AstraDiscord) {
    window.AstraDiscord.bindUI({
      connectBtn: el.discordConnect,
      badge: el.discordConnected,
      usernameEl: el.discordUsername,
      disconnectBtn: el.discordDisconnect,
      onChange: () => {
        el.gateName.value = AstraProfile.getName();
        picker.repaint();
        if (state.signal) {
          const banner = AstraProfile.getBanner();
          const avatar = AstraProfile.getAvatar();
          const name = AstraProfile.getName();
          const dev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
          state.signal.setState({ name, avatar, banner, dev });
          renderPeople();
        }
      },
      onError: profileError,
    });
  }

  // ------------------------------------------------ In-Room Profile Modal

  let openProfileModal = () => {};

  function setupProfileModal() {
    if (!el.toggleProfile || !el.profileModal) return;

    let modalBanner = AstraProfile.getBanner();
    let modalAvatar = AstraProfile.getAvatar();

    function renderModalBadgesAndDiscord() {
      if (el.profileModalUserBadges) {
        const isDev = !!(window.AstraDiscord && window.AstraDiscord.isDev());
        if (isDev) {
          if (!el.profileModalUserBadges.hasChildNodes()) {
            el.profileModalUserBadges.appendChild(window.AstraDiscord.createDevBadge('Developer'));
          }
          el.profileModalUserBadges.hidden = false;
        } else {
          el.profileModalUserBadges.textContent = '';
          el.profileModalUserBadges.hidden = true;
        }
      }

      if (window.AstraDiscord && el.profileModalDiscord && el.profileModalDiscordUser) {
        const user = window.AstraDiscord.getUser();
        if (user && user.username) {
          const discordLabel = '@' + (user.global_name ? `${user.global_name} (${user.username})` : user.username);
          if (el.profileModalDiscordUser.textContent !== discordLabel) {
            el.profileModalDiscordUser.textContent = discordLabel;
          }
          el.profileModalDiscord.hidden = false;
        } else {
          el.profileModalDiscord.hidden = true;
        }
      }
    }

    function renderModalPreview() {
      const name = (el.profileModalName.value || AstraProfile.getName() || 'Guest').trim();
      AstraProfile.paintBanner(el.profileModalBanner, modalBanner, name);
      AstraProfile.paint(el.profileModalAvatar, name, modalAvatar);
      if (el.bannerClearBtn) el.bannerClearBtn.hidden = !modalBanner;
      if (el.profileAvatarClear) el.profileAvatarClear.hidden = !modalAvatar;
    }

    function openModal() {
      modalBanner = AstraProfile.getBanner();
      modalAvatar = AstraProfile.getAvatar();
      el.profileModalName.value = AstraProfile.getName();
      syncThemeUI();
      renderModalBadgesAndDiscord();
      renderModalPreview();
      el.profileModal.hidden = false;
      if (el.toggleProfile) el.toggleProfile.setAttribute('aria-pressed', 'true');
      document.addEventListener('keydown', handleModalKey);
      setTimeout(() => el.profileModalName.focus(), 50);
    }

    /** Slider position and the grey swatch's ring both follow the stored hue. */
    function syncThemeUI() {
      const hue = window.AstraTheme.getHue();
      if (el.themeHue) el.themeHue.value = String(hue === null ? 0 : hue);
      if (el.themeReset) el.themeReset.classList.toggle('is-active', hue === null);
    }

    if (el.themeHue) {
      el.themeHue.addEventListener('input', () => {
        window.AstraTheme.setHue(Number(el.themeHue.value));
        syncThemeUI();
      });
    }

    if (el.themeReset) {
      el.themeReset.addEventListener('click', () => {
        window.AstraTheme.setHue(null);
        syncThemeUI();
      });
    }

    openProfileModal = openModal;

    function closeModal() {
      el.profileModal.hidden = true;
      if (el.toggleProfile) el.toggleProfile.setAttribute('aria-pressed', 'false');
      document.removeEventListener('keydown', handleModalKey);
    }

    function handleModalKey(e) {
      if (e.key === 'Escape') closeModal();
    }

    function saveChanges() {
      const newName = AstraProfile.setName(el.profileModalName.value);
      AstraProfile.setAvatar(modalAvatar);
      AstraProfile.setBanner(modalBanner);

      if (state.signal) {
        state.signal.setState({
          name: newName,
          avatar: modalAvatar,
          banner: modalBanner,
        });
      }

      if (window.AstraDiscord) {
        if (window.AstraDiscord.saveAccountAvatar) {
          window.AstraDiscord.saveAccountAvatar(modalAvatar);
        }
        if (window.AstraDiscord.syncBanner) {
          window.AstraDiscord.syncBanner(modalBanner);
        }
      }

      if (el.gateName) el.gateName.value = newName;
      picker.repaint();
      renderPeople();
      closeModal();
      toast('Profile updated');
    }

    el.toggleProfile.addEventListener('click', () => {
      if (el.profileModal.hidden) openModal();
      else closeModal();
    });
    el.profileModalClose.addEventListener('click', closeModal);
    el.profileModalBackdrop.addEventListener('click', closeModal);
    el.profileModalSave.addEventListener('click', saveChanges);

    el.profileModalName.addEventListener('input', renderModalPreview);

    // Banner handlers
    el.bannerChangeBtn.addEventListener('click', () => el.bannerFile.click());
    el.bannerFile.addEventListener('change', async () => {
      const file = el.bannerFile.files && el.bannerFile.files[0];
      el.bannerFile.value = '';
      if (!file) return;
      try {
        const cropped = await AstraProfile.editBanner(file);
        if (cropped) {
          modalBanner = cropped;
          renderModalPreview();
        }
      } catch (err) {
        toast(err.message || 'Could not load banner', 'bad');
      }
    });

    el.bannerClearBtn.addEventListener('click', () => {
      modalBanner = null;
      renderModalPreview();
    });

    // Avatar handlers
    el.profileAvatarChange.addEventListener('click', () => el.profileAvatarFile.click());
    el.profileAvatarFile.addEventListener('change', async () => {
      const file = el.profileAvatarFile.files && el.profileAvatarFile.files[0];
      el.profileAvatarFile.value = '';
      if (!file) return;
      try {
        const cropped = await AstraProfile.edit(file);
        if (cropped) {
          modalAvatar = cropped;
          renderModalPreview();
        }
      } catch (err) {
        toast(err.message || 'Could not load picture', 'bad');
      }
    });

    el.profileAvatarClear.addEventListener('click', () => {
      modalAvatar = null;
      renderModalPreview();
    });
  }

  setupProfileModal();

  /** Swap the gate between its form and the loading dots. */
  function setGateLoading(on) {
    el.gate.classList.toggle('working', on);
    el.gateLoader.hidden = !on;
  }

  function friendlyError(err) {
    if (!err) return 'Something went wrong.';
    if (err.type === 'browser-incompatible') return 'This browser cannot do WebRTC.';
    if (err.type === 'network' || err.type === 'server-error') {
      return 'Could not reach the signalling broker. Check your connection and try again.';
    }
    return err.message || String(err);
  }

  // ------------------------------------------------------------- room set-up

  function enterRoom() {
    const signal = state.signal;

    el.topbar.hidden = false;
    el.stage.hidden = false;
    el.sidebar.hidden = false;
    el.controls.hidden = false;
    el.gate.classList.add('gate-fade-out');
    setTimeout(() => {
      el.gate.hidden = true;
      el.gate.classList.remove('gate-fade-out');
      setGateLoading(false); // leave the gate in a clean state behind us
    }, 200);

    // The glow sphere repositions from gate (52vh) to empty stage (50%),
    // so trigger a fade-in animation for the position change.
    const emptyGlow = document.querySelector('#empty .bg-glow-sphere');
    if (emptyGlow) {
      emptyGlow.classList.add('glow-entering');
      emptyGlow.addEventListener('animationend', () => {
        emptyGlow.classList.remove('glow-entering');
      }, { once: true });
    }
    el.roomCode.textContent = signal.code;
    document.title = signal.code + ' — Astra';

    // Creating a room lands on ?create=1; rewrite so a refresh or a copied URL
    // rejoins the same room instead of opening a new one.
    history.replaceState(null, '', '?room=' + encodeURIComponent(signal.code));
    if (signal.isHub) {
      notifyRoomApi('create', signal.code, signal.roster ? signal.roster.size : 1);
    }
    startRoomApiHeartbeat(signal.code);

    if (!window.AstraMedia.canShareScreen && el.shareGroup) {
      el.shareGroup.hidden = true;
    }
    setShareUI(false);
    setCameraUI(false);
    setMicUI(false);

    // One outgoing stream for the whole session. Its audio track is the mixer
    // output, so mic and system audio can come and go without renegotiating.
    state.localStream = new MediaStream([state.mixer.track]);
    state.mesh = new Mesh({
      selfId: signal.selfId,
      signal,
      iceServers: window.ASTRA.iceServers,
    });
    state.mesh.setLocalStream(state.localStream);

    for (const peer of signal.others()) state.mesh.add(peer.id);

    signal.addEventListener('peer-joined', (e) => {
      state.mesh.add(e.detail.peer.id);
      toast(e.detail.peer.name + ' joined');
      renderPeople();
    });

    signal.addEventListener('peer-left', (e) => {
      const id = e.detail.id;
      const name = e.detail.name;
      const reason = e.detail.reason;
      state.mesh.remove(id);
      dropPeerMedia(id);
      vad.detach(id);
      renderPeople();
      if (reason === 'timeout') {
        toast((name || 'A participant') + ' disconnected (connection lost)', 'bad');
      }
    });

    signal.addEventListener('signal', (e) => state.mesh.handleSignal(e.detail.from, e.detail.data));

    signal.addEventListener('peer-state', (e) => {
      renderPeople();
      if (e.detail.patch && e.detail.patch.mic === false) {
        setSpeaking(e.detail.id, false);
      }
      refreshPeerTiles(e.detail.id);
    });

    signal.addEventListener('chat', (e) => addMessage(e.detail));
    signal.addEventListener('closed', (e) => showClosed(e.detail.reason));
    signal.addEventListener('kicked', (e) => showClosed(e.detail.reason || 'You were kicked from the room by the host.'));
    signal.addEventListener('host-changed', (e) => {
      const isSelf = e.detail.hostId === state.signal.selfId;
      toast(isSelf ? 'You are now the room host' : (e.detail.hostName ? `${e.detail.hostName} is now the room host` : 'Room host changed'));
      renderPeople();
      if (isSelf && signal.code) {
        startRoomApiHeartbeat(signal.code);
      }
    });
    signal.addEventListener('error', (e) => toast(friendlyError(e.detail), 'bad'));

    state.mesh.addEventListener('stream', (e) => {
      const { id, stream, track } = e.detail;
      state.remote.set(id, stream);
      if (stream.getAudioTracks().length > 0) {
        attachAudio(id, stream);
      }
      if (track && track.kind === 'video') {
        let set = state.remoteVideoTracks.get(id);
        if (!set) {
          set = new Set();
          state.remoteVideoTracks.set(id, set);
        }
        set.add(track);
      }
      // Tracks can join or leave this stream long after we first see it - when
      // the peer starts or stops sharing - so re-check the tile every time.
      if (!stream.__astraWatched) {
        stream.__astraWatched = true;
        stream.addEventListener('addtrack', (ev) => {
          if (ev.track && ev.track.kind === 'video') {
            let set = state.remoteVideoTracks.get(id);
            if (!set) {
              set = new Set();
              state.remoteVideoTracks.set(id, set);
            }
            set.add(ev.track);
          }
          refreshPeerTiles(id);
          vad.attach(id, stream);
        });
        stream.addEventListener('removetrack', (ev) => {
          if (ev.track && ev.track.kind === 'video') {
            const set = state.remoteVideoTracks.get(id);
            if (set) set.delete(ev.track);
          }
          refreshPeerTiles(id);
          vad.attach(id, stream);
        });
      }
      refreshPeerTiles(id);
    });
    state.mesh.addEventListener('trackended', (e) => {
      if (e.detail.track.kind === 'video') {
        const set = state.remoteVideoTracks.get(e.detail.id);
        if (set) set.delete(e.detail.track);
        refreshPeerTiles(e.detail.id);
      }
    });
    state.mesh.addEventListener('trackmuted', (e) => {
      if (e.detail.track.kind === 'video') refreshPeerTiles(e.detail.id);
    });
    state.mesh.addEventListener('trackunmuted', (e) => {
      if (e.detail.track.kind === 'video') refreshPeerTiles(e.detail.id);
    });
    state.mesh.addEventListener('connectionstate', (e) => {
      if (e.detail.state !== 'failed') return;
      const peer = state.signal.roster.get(e.detail.id);
      toast('Trouble reaching ' + (peer ? peer.name : 'someone') + ' — retrying…', 'bad');
    });

    const myAvatar = AstraProfile.getAvatar();
    const myBanner = AstraProfile.getBanner();
    if (myAvatar || myBanner) signal.setState({ avatar: myAvatar, banner: myBanner });

    renderPeople();
    updateEmptyState();
    applyLayout();
    syncPanels();
    setStatus(wantsCreate ? 'Room ready — copy the link to invite someone.' : 'Joined the room.');
  }

  // --------------------------------------------------------------- sharing

  el.share.addEventListener('click', () => toggleSharing());

  function toggleSharing() {
    if (el.share.disabled) return;
    if (state.sharing) stopSharing();
    else startSharing();
  }

  async function startSharing() {
    if (!state.signal || !state.mesh) return;
    if (!window.AstraMedia.canShareScreen) {
      toast('Screen sharing is not supported on this device/browser', 'bad');
      return;
    }
    el.share.disabled = true;
    try {
      if (state.mixer) await state.mixer.resume();
      const prioritizeFluidity = el.fluidity ? el.fluidity.checked : true;
      const capture = await captureScreen(el.quality.value, el.systemAudio.checked);

      state.videoStream = capture.stream;
      state.videoTrack = capture.stream.getVideoTracks()[0];
      if (!state.videoTrack) throw new Error('No video track came back from the picker.');

      // The browser's own "Stop sharing" bar ends the track behind our back.
      state.videoTrack.addEventListener('ended', () => stopSharing());
      state.videoTrack.contentHint = 'detail';

      state.localStream.addTrack(state.videoTrack);
      if (state.mixer.add('system', capture.stream)) {
        setStatus('Sharing with system audio.');
      } else if (el.systemAudio.checked) {
        // The browser remembers the picker's audio tick box per site, so this
        // sticks until it is turned back on - worth flagging, not whispering.
        setStatus('Sharing without audio — tick “Share audio” in the picker.', 'bad');
      } else {
        setStatus('Sharing.');
      }

      state.mesh.setMaxVideoBitrate(capture.quality.bitrate, capture.quality.frameRate);
      state.mesh.setDegradationPreference(prioritizeFluidity ? 'maintain-framerate' : 'maintain-resolution');
      state.mesh.publish();

      state.sharing = true;
      if (state.signal) state.signal.setState({ sharing: true, screenTrackId: state.videoTrack.id });
      setShareUI(true);
      el.systemAudio.disabled = true;
      el.quality.disabled = true;
      if (el.qualityTrigger) el.qualityTrigger.classList.add('is-disabled');
      if (el.systemAudioRow) el.systemAudioRow.classList.add('is-disabled');
      hideQualityDropdown(0);
      updateSelfTiles();
      renderPeople();
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setStatus('Share cancelled.');
      } else {
        console.error(err);
        setStatus('Could not start sharing: ' + (err.message || err.name), 'bad');
      }
      cleanUpCapture();
    } finally {
      el.share.disabled = false;
    }
  }

  function stopSharing() {
    if (!state.sharing) return cleanUpCapture();
    cleanUpCapture();
    if (state.mesh) {
      if (!state.cameraOn) {
        state.mesh.setDegradationPreference('maintain-framerate');
      }
      state.mesh.publish();
    }
    state.sharing = false;
    if (state.signal) state.signal.setState({ sharing: false, screenTrackId: null });
    updateSelfTiles();
    setShareUI(false);
    el.systemAudio.disabled = false;
    el.quality.disabled = false;
    if (el.qualityTrigger) el.qualityTrigger.classList.remove('is-disabled');
    if (el.systemAudioRow) el.systemAudioRow.classList.remove('is-disabled');
    setStatus('Stopped sharing.');
    renderPeople();
    updateEmptyState();
  }

  function cleanUpCapture() {
    if (state.mixer) state.mixer.remove('system');
    if (state.videoTrack && state.localStream && state.localStream.getTracks().includes(state.videoTrack)) {
      state.localStream.removeTrack(state.videoTrack);
    }
    stopStream(state.videoStream);
    state.videoStream = null;
    state.videoTrack = null;
  }

  function setShareUI(active) {
    const label = active ? 'Stop sharing screen' : 'Share your screen';
    el.share.classList.toggle('is-live', active);
    el.share.title = label;
    el.shareLabel.textContent = label;
  }

  // ---------------------------------------------------------------- camera

  if (el.camera) {
    el.camera.addEventListener('click', () => toggleCamera());
  }

  function setCameraUI(active) {
    if (!el.camera) return;
    const label = active ? 'Turn off camera (C)' : 'Turn on camera (C)';
    el.camera.classList.toggle('is-live', active);
    el.camera.setAttribute('aria-pressed', String(active));
    el.camera.title = label;
    if (el.cameraLabel) {
      el.cameraLabel.textContent = active ? 'Camera on' : 'Camera off';
    }
  }

  async function startCamera() {
    if (!state.signal || !state.mesh) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera is not supported on this device/browser', 'bad');
      return;
    }
    if (el.camera) el.camera.disabled = true;
    try {
      if (state.mixer) await state.mixer.resume();
      const capture = await captureCamera(el.quality ? el.quality.value : '720', 'user', state.cameraDeviceId);

      if (state.cameraStream) {
        cleanUpCamera();
      }

      state.cameraStream = capture.stream;
      state.cameraTrack = capture.stream.getVideoTracks()[0];
      if (!state.cameraTrack) throw new Error('No camera video track found.');

      state.cameraTrack.contentHint = 'motion';
      const trackSettings = state.cameraTrack.getSettings ? state.cameraTrack.getSettings() : null;
      if (trackSettings && trackSettings.deviceId) {
        state.cameraDeviceId = trackSettings.deviceId;
        try { localStorage.setItem('astra:camera-device', state.cameraDeviceId); } catch (_) {}
      }

      state.cameraTrack.addEventListener('ended', () => stopCamera());

      state.localStream.addTrack(state.cameraTrack);
      if (!state.sharing) {
        state.mesh.setMaxVideoBitrate(capture.quality.bitrate || 2000000, capture.quality.frameRate || 30);
        state.mesh.setDegradationPreference('maintain-framerate');
      }
      state.mesh.publish();

      state.cameraOn = true;
      if (state.signal) state.signal.setState({ camera: true, cameraTrackId: state.cameraTrack.id });
      setCameraUI(true);
      updateSelfTiles();
      renderPeople();
      setStatus('Camera on.');
      populateCameraDevices();
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        setStatus('Camera permission denied or cancelled.');
      } else {
        console.error(err);
        setStatus('Could not start camera: ' + (err.message || err.name), 'bad');
      }
      cleanUpCamera();
    } finally {
      if (el.camera) el.camera.disabled = false;
    }
  }

  function stopCamera() {
    if (!state.cameraOn) return cleanUpCamera();
    cleanUpCamera();
    if (state.mesh) {
      state.mesh.publish();
    }
    state.cameraOn = false;
    if (state.signal) state.signal.setState({ camera: false, cameraTrackId: null });
    updateSelfTiles();
    setCameraUI(false);
    setStatus('Camera off.');
    renderPeople();
    updateEmptyState();
  }

  function cleanUpCamera() {
    if (state.cameraTrack && state.localStream && state.localStream.getTracks().includes(state.cameraTrack)) {
      state.localStream.removeTrack(state.cameraTrack);
    }
    stopStream(state.cameraStream);
    state.cameraStream = null;
    state.cameraTrack = null;
  }

  function toggleCamera() {
    if (el.camera?.disabled) return;
    if (state.cameraOn) stopCamera();
    else startCamera();
  }

  // ---------------------------------------------------- camera settings menu

  let cachedCameraDevices = [];
  let cameraDevicesPromise = null;
  let cameraDeviceChangeTimer = null;

  const checkSvgTemplate = (() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'dock-dropdown-check');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<polyline points="20 6 9 17 4 12" />';
    return svg;
  })();

  function updateCameraDeviceSelection() {
    if (!el.cameraDevicesList) return;
    const items = el.cameraDevicesList.querySelectorAll('.dock-menu-item');
    items.forEach((item) => {
      const isSelected = item.dataset.deviceId === state.cameraDeviceId;
      item.classList.toggle('is-selected', isSelected);
      item.setAttribute('aria-selected', String(isSelected));
    });
  }

  async function populateCameraDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      if (el.cameraDevicesList) {
        el.cameraDevicesList.innerHTML = '<div class="dock-menu-empty">Camera selection not supported</div>';
      }
      return;
    }

    if (cameraDevicesPromise) return cameraDevicesPromise;

    cameraDevicesPromise = (async () => {
      let devices = [];
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        devices = allDevices.filter((d) => d.kind === 'videoinput');
      } catch (_) {
        devices = [];
      } finally {
        cameraDevicesPromise = null;
      }

      if (!el.cameraDevicesList) return;

      const deviceSignature = devices.map((d) => d.deviceId + ':' + d.label).join('|');
      const prevSignature = cachedCameraDevices.map((d) => d.deviceId + ':' + d.label).join('|');
      cachedCameraDevices = devices;

      if (!state.cameraDeviceId && devices.length > 0) {
        state.cameraDeviceId = devices[0].deviceId;
      }

      if (deviceSignature === prevSignature && el.cameraDevicesList.children.length > 0) {
        updateCameraDeviceSelection();
        return;
      }

      el.cameraDevicesList.textContent = '';

      if (devices.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dock-menu-empty';
        empty.textContent = 'No cameras found';
        el.cameraDevicesList.appendChild(empty);
        return;
      }

      const fragment = document.createDocumentFragment();

      devices.forEach((device, index) => {
        const item = document.createElement('div');
        item.className = 'dock-menu-item dock-menu-action';
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.dataset.deviceId = device.deviceId;

        const isSelected = state.cameraDeviceId === device.deviceId;
        if (isSelected) item.classList.add('is-selected');
        item.setAttribute('aria-selected', String(isSelected));

        const labelSpan = document.createElement('span');
        labelSpan.className = 'dock-menu-label';
        labelSpan.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; font-size:13px;';
        labelSpan.textContent = device.label || ('Camera ' + (index + 1));

        item.append(labelSpan, checkSvgTemplate.cloneNode(true));

        const choose = async (e) => {
          e.stopPropagation();
          await selectCameraDevice(device.deviceId);
          toggleCameraMenu(false);
        };

        item.addEventListener('click', choose);
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(e);
          }
        });

        fragment.appendChild(item);
      });

      el.cameraDevicesList.appendChild(fragment);
    })();

    return cameraDevicesPromise;
  }

  async function selectCameraDevice(deviceId) {
    if (state.cameraDeviceId === deviceId && state.cameraOn) return;
    state.cameraDeviceId = deviceId;
    try { localStorage.setItem('astra:camera-device', deviceId); } catch (_) {}
    updateCameraDeviceSelection();
    if (state.cameraOn) {
      await startCamera();
    }
  }

  function repositionCameraMenu() {
    if (!el.cameraMenu || el.cameraMenu.hidden) return;
    if (window.innerWidth > 860 && el.controls && (el.cameraGroup || el.camera)) {
      const dockRect = el.controls.getBoundingClientRect();
      const target = el.cameraGroup || el.camera;
      const groupRect = target.getBoundingClientRect();
      const leftOffset = Math.max(0, Math.min(groupRect.left - dockRect.left, Math.max(0, dockRect.width - 240)));
      el.cameraMenu.style.left = leftOffset + 'px';
    } else {
      el.cameraMenu.style.left = '';
    }
  }

  function toggleCameraMenu(force) {
    if (!el.cameraMenu || !el.cameraOptions) return;
    const open = force === undefined ? el.cameraMenu.hidden : force;
    if (el.cameraMenu.hidden === !open) return;
    el.cameraMenu.hidden = !open;
    el.cameraOptions.setAttribute('aria-expanded', String(open));
    if (open) {
      toggleShareMenu(false);
      populateCameraDevices();
      repositionCameraMenu();
    }
  }

  if (el.cameraOptions) {
    el.cameraOptions.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleCameraMenu();
    });
  }

  if (el.cameraMenu) {
    el.cameraMenu.addEventListener('click', (event) => event.stopPropagation());
  }

  const onDeviceChange = () => {
    if (cameraDeviceChangeTimer) clearTimeout(cameraDeviceChangeTimer);
    cameraDeviceChangeTimer = setTimeout(() => {
      cameraDeviceChangeTimer = null;
      populateCameraDevices();
    }, 250);
  };

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
  }

  const onCameraWindowResize = () => {
    repositionCameraMenu();
  };
  window.addEventListener('resize', onCameraWindowResize);

  function toggleShareMenu(force) {
    const open = force === undefined ? el.shareMenu.hidden : force;
    if (el.shareMenu.hidden === !open) return;
    el.shareMenu.hidden = !open;
    el.shareOptions.setAttribute('aria-expanded', String(open));
    if (!open) hideQualityDropdown(0);
    else toggleCameraMenu(false);
  }

  el.shareOptions.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleShareMenu();
  });

  el.shareMenu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => {
    // Closed explicitly rather than through the share menu's cascade: that
    // cascade is skipped when the menu is already shut, and each of these is a
    // no-op when it has nothing to close.
    toggleShareMenu(false);
    toggleCameraMenu(false);
    hideQualityDropdown(0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      toggleShareMenu(false);
      toggleCameraMenu(false);
    }
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (inInput || !state.signal) return;
    if (event.key === 'd' || event.key === 'D') {
      toggleDeafen();
    }
    if (event.key === 'm' || event.key === 'M') {
      toggleMic();
    }
    if (event.key === 'c' || event.key === 'C') {
      toggleCamera();
    }
  });

  let qualityDropdownTimer = null;

  function toggleQualityDropdown(force) {
    if (!el.qualityDropdown || !el.qualityTrigger) return;
    if (el.quality.disabled) return;
    const open = force === undefined ? el.qualityDropdown.hidden : force;
    if (el.qualityDropdown.hidden === !open) return;
    el.qualityDropdown.hidden = !open;
    el.qualityTrigger.setAttribute('aria-expanded', String(open));
    if (open) {
      const rect = el.shareMenu.getBoundingClientRect();
      // Measure the real flyout rather than guessing: it is already laid out
      // by now, and a hardcoded width silently drifts from the stylesheet.
      const dropdownWidth = el.qualityDropdown.getBoundingClientRect().width;
      if (rect.right + dropdownWidth + 16 > window.innerWidth) {
        el.qualityDropdown.style.left = 'auto';
        el.qualityDropdown.style.right = 'calc(100% + 8px)';
      } else {
        el.qualityDropdown.style.left = 'calc(100% + 8px)';
        el.qualityDropdown.style.right = 'auto';
      }
    }
  }

  function showQualityDropdown() {
    if (qualityDropdownTimer) clearTimeout(qualityDropdownTimer);
    toggleQualityDropdown(true);
  }

  function hideQualityDropdown(delay = 0) {
    if (qualityDropdownTimer) clearTimeout(qualityDropdownTimer);
    if (delay > 0) {
      qualityDropdownTimer = setTimeout(() => {
        toggleQualityDropdown(false);
      }, delay);
    } else {
      toggleQualityDropdown(false);
    }
  }

  if (el.qualityWrap) {
    el.qualityWrap.addEventListener('mouseenter', () => showQualityDropdown());
    el.qualityWrap.addEventListener('mouseleave', () => hideQualityDropdown(150));
  }

  if (el.systemAudioRow) {
    el.systemAudioRow.addEventListener('click', () => hideQualityDropdown(0));
  }

  if (el.fluidityRow) {
    el.fluidityRow.addEventListener('click', () => hideQualityDropdown(0));
  }

  if (el.fluidity) {
    el.fluidity.addEventListener('change', () => {
      const on = el.fluidity.checked;
      if (state.mesh) {
        state.mesh.setDegradationPreference(on ? 'maintain-framerate' : 'maintain-resolution');
      }
      if (state.videoTrack && 'contentHint' in state.videoTrack) {
        state.videoTrack.contentHint = on ? 'motion' : 'detail';
      }
      setStatus(on ? 'Prioritizing smooth fluidity.' : 'Prioritizing crisp resolution.');
    });
  }

  if (el.qualityTrigger) {
    el.qualityTrigger.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleQualityDropdown();
    });
    el.qualityTrigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleQualityDropdown();
      }
    });
  }

  const dropdownItems = el.qualityDropdown
    ? el.qualityDropdown.querySelectorAll('.dock-dropdown-item')
    : [];

  dropdownItems.forEach((item) => {
    const pick = () => {
      const val = item.getAttribute('data-value');
      if (!val || el.quality.disabled) return;
      el.quality.value = val;
      updateQualitySelection(val);
      el.quality.dispatchEvent(new Event('change'));
    };

    item.addEventListener('click', (event) => {
      event.stopPropagation();
      pick();
    });

    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
  });

  function updateQualitySelection(val) {
    dropdownItems.forEach((item) => {
      const isMatch = item.getAttribute('data-value') === val;
      item.classList.toggle('is-selected', isMatch);
      item.setAttribute('aria-selected', String(isMatch));
      if (isMatch && el.qualityVal) {
        const textSpan = item.querySelector('span');
        if (textSpan) el.qualityVal.textContent = textSpan.textContent;
      }
    });
  }

  el.quality.addEventListener('change', () => {
    updateQualitySelection(el.quality.value);
    const quality = QUALITY[el.quality.value];
    if (quality && state.mesh) state.mesh.setMaxVideoBitrate(quality.bitrate);
  });
  updateQualitySelection(el.quality.value);

  // -------------------------------------------------------------- microphone

  el.mic.addEventListener('click', () => toggleMic());

  async function toggleMic() {
    if (el.mic.disabled) return;
    el.mic.disabled = true;
    try {
      await state.mixer.resume();
      if (state.micOn) {
        stopMicCapture();
        if (state.signal) {
          state.signal.setState({ mic: false });
        }
        setStatus('Microphone off.');
        renderPeople();
      } else {
        // If the user is deafened, trying to enable the mic removes deafen
        if (state.deafened) {
          setDeafened(false);
        }
        state.micStream = await captureMicrophone();
        state.mixer.add('mic', state.micStream);
        state.micOn = true;
        vad.attach('self', state.micStream);
        setMicUI(true);
        if (state.signal) {
          state.signal.setState({ mic: true });
        }
        setStatus('Microphone on.');
        renderPeople();
      }
    } catch (err) {
      console.error(err);
      setStatus('No microphone: ' + (err.message || err.name), 'bad');
    } finally {
      el.mic.disabled = false;
    }
  }

  /** Release the microphone and put every mic-related indicator back to off. */
  function stopMicCapture() {
    if (state.mixer) state.mixer.remove('mic');
    stopStream(state.micStream);
    state.micStream = null;
    state.micOn = false;
    vad.detach('self');
    setMicUI(false);
  }

  function setMicUI(on) {
    el.mic.classList.toggle('is-live', on);
    el.mic.setAttribute('aria-pressed', String(on));
    el.mic.title = on ? 'Mute the microphone (M)' : 'Turn the microphone on (M)';
    el.micLabel.textContent = on ? 'Microphone on' : 'Microphone off';
  }

  // -------------------------------------------------------------------- deafen

  if (el.deafen) {
    el.deafen.addEventListener('click', () => toggleDeafen());
  }

  function toggleDeafen() {
    setDeafened(!state.deafened);
  }

  function setDeafened(on) {
    state.deafened = on;
    for (const [peerId, audio] of state.audios) {
      if (on) {
        audio.muted = true;
      } else {
        const vol = getPeerVolume(peerId);
        audio.muted = vol.muted;
        audio.volume = vol.muted ? 0 : vol.volume;
      }
    }
    if (el.deafen) {
      el.deafen.classList.toggle('is-live', on);
      el.deafen.setAttribute('aria-pressed', String(on));
      el.deafen.title = on ? 'Undeafen (D)' : 'Deafen (D)';
      if (el.deafenLabel) el.deafenLabel.textContent = on ? 'Deafened' : 'Undeafened';
    }

    const patch = { deafened: on };
    // Deafening also closes the microphone - you cannot talk into a room you
    // are not listening to.
    if (on && state.micOn) {
      stopMicCapture();
      patch.mic = false;
    }

    if (state.signal) {
      state.signal.setState(patch);
    }
    renderPeople();
    setStatus(on ? 'Deafen.' : 'Undeafen.');
  }

  // -------------------------------------------------------------------- tiles

  const VOLUME_HIGH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />' +
    '<path d="M19.07 4.93a10 10 0 0 1 0 14.14" />' +
    '</svg><span class="sr-only">Stream volume</span>';

  const VOLUME_LOW_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07" />' +
    '</svg><span class="sr-only">Stream volume</span>';

  const VOLUME_MUTED_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />' +
    '<line x1="23" y1="9" x2="17" y2="15" />' +
    '<line x1="17" y1="9" x2="23" y2="15" />' +
    '</svg><span class="sr-only">Stream volume</span>';

  const WATCHING_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />' +
    '<circle cx="12" cy="12" r="3" />' +
    '</svg><span class="sr-only">Stop watching screen</span>';

  const NOT_WATCHING_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />' +
    '<line x1="1" y1="1" x2="23" y2="23" />' +
    '</svg><span class="sr-only">Start watching screen</span>';

  function getPeerVolume(id) {
    if (!state.peerVolumes.has(id)) {
      state.peerVolumes.set(id, { volume: 1.0, muted: false });
    }
    return state.peerVolumes.get(id);
  }

  function setPeerVolume(id, vol, muted) {
    const data = getPeerVolume(id);
    if (vol !== undefined) data.volume = Math.max(0, Math.min(1, vol));
    if (muted !== undefined) data.muted = muted;

    const audio = state.audios.get(id);
    if (audio) {
      audio.volume = data.muted ? 0 : data.volume;
      audio.muted = state.deafened || data.muted;
    }

    for (const tile of state.tiles.values()) {
      if (tile.peerId === id && tile.updateVolumeUI) {
        tile.updateVolumeUI();
      }
    }
    if (activePopupPeerId === id && typeof updatePopupVolumeUI === 'function') {
      updatePopupVolumeUI(id);
    }
  }

  function setTileWatching(tileKey, isWatching) {
    state.peerWatching.set(tileKey, isWatching);
    const tile = state.tiles.get(tileKey);
    if (!tile) return;

    const stream = tile.video.srcObject;
    if (stream) {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = isWatching;
      });
    }

    if (tile.pausedOverlay) {
      tile.pausedOverlay.hidden = isWatching;
    }
    if (tile.watchBtn) {
      tile.watchBtn.classList.toggle('is-paused', !isWatching);
      tile.watchBtn.title = isWatching ? 'Stop watching' : 'Start watching';
      tile.watchBtn.setAttribute('aria-label', isWatching ? 'Stop watching' : 'Start watching');
      tile.watchBtn.innerHTML = isWatching ? WATCHING_ICON : NOT_WATCHING_ICON;
    }

    if (isWatching) {
      tile.video.style.visibility = '';
      tile.video.play().catch(() => {});
    } else {
      tile.video.pause();
      tile.video.style.visibility = 'hidden';
      if (tile.pausedAvatar && tile.pausedName) {
        const peer = state.signal?.roster.get(tile.peerId);
        const name = peer ? peer.name : (tile.peerId === state.signal?.selfId ? 'You' : 'Guest');
        tile.pausedName.textContent = name;
        AstraProfile.paint(tile.pausedAvatar, name, peer ? peer.avatar : null);
      }
    }
  }

  function tileFor(tileKey, name, peerId, kind) {
    let tile = state.tiles.get(tileKey);
    if (tile) {
      if (name && tile.label) tile.label.textContent = name;
      return tile;
    }

    const actualPeerId = peerId || tileKey;
    const isSelf = actualPeerId === state.signal?.selfId;

    // The slot holds the share of the stage; the tile inside stays 16:9.
    const slot = document.createElement('div');
    slot.className = 'slot';

    const root = document.createElement('figure');
    root.className = 'tile';
    root.dataset.peer = actualPeerId;
    root.dataset.tileKey = tileKey;
    if (kind) root.dataset.kind = kind;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio plays through a separate element, never twice
    root.appendChild(video);

    // Paused overlay for when user stops watching
    let pausedOverlay = null;
    let pausedAvatar = null;
    let pausedName = null;

    if (!isSelf) {
      pausedOverlay = document.createElement('div');
      pausedOverlay.className = 'tile-paused-overlay';
      pausedOverlay.hidden = true;

      const pausedCard = document.createElement('div');
      pausedCard.className = 'tile-paused-card';

      pausedAvatar = document.createElement('span');
      pausedAvatar.className = 'avatar tile-paused-avatar';

      const pausedInfo = document.createElement('div');
      pausedInfo.className = 'tile-paused-info';

      pausedName = document.createElement('span');
      pausedName.className = 'tile-paused-name';
      pausedName.textContent = name;

      const pausedStatus = document.createElement('span');
      pausedStatus.className = 'tile-paused-status';
      pausedStatus.textContent = 'Stream paused';

      pausedInfo.append(pausedName, pausedStatus);

      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = 'tile-resume-btn';
      resumeBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<polygon points="5 3 19 12 5 21 5 3" /></svg>' +
        '<span>Watch stream</span>';
      resumeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setTileWatching(tileKey, true);
      });

      pausedCard.append(pausedAvatar, pausedInfo, resumeBtn);
      pausedOverlay.appendChild(pausedCard);
      root.appendChild(pausedOverlay);
    }

    const caption = document.createElement('figcaption');
    const label = document.createElement('span');
    label.className = 'tile-name';
    label.textContent = name;
    const buttons = document.createElement('span');
    buttons.className = 'tile-actions';

    // Volume control with expanding slider (for remote peers)
    let volumeBtn = null;
    let volumeSlider = null;

    if (!isSelf) {
      const volumeControl = document.createElement('div');
      volumeControl.className = 'tile-volume-control';

      volumeBtn = document.createElement('button');
      volumeBtn.type = 'button';
      volumeBtn.className = 'tile-btn tile-volume-btn';
      volumeBtn.title = 'Mute stream';

      const sliderWrap = document.createElement('div');
      sliderWrap.className = 'tile-volume-slider-wrap';

      volumeSlider = document.createElement('input');
      volumeSlider.type = 'range';
      volumeSlider.className = 'tile-volume-slider';
      volumeSlider.min = '0';
      volumeSlider.max = '100';
      volumeSlider.value = '100';
      volumeSlider.setAttribute('aria-label', 'Stream volume');

      sliderWrap.append(volumeSlider);
      volumeControl.append(sliderWrap, volumeBtn);

      volumeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const data = getPeerVolume(actualPeerId);
        if (data.muted) {
          const restore = data.volume > 0 ? data.volume : 1.0;
          setPeerVolume(actualPeerId, restore, false);
        } else {
          setPeerVolume(actualPeerId, data.volume, true);
        }
      });

      volumeSlider.addEventListener('input', (event) => {
        event.stopPropagation();
        const val = parseFloat(volumeSlider.value) / 100;
        setPeerVolume(actualPeerId, val, val === 0);
      });

      volumeSlider.addEventListener('click', (event) => event.stopPropagation());
      volumeSlider.addEventListener('pointerdown', (event) => event.stopPropagation());
      volumeControl.addEventListener('click', (event) => event.stopPropagation());

      buttons.appendChild(volumeControl);
    }

    // Stop/start watching screen button (for remote peers)
    let watchBtn = null;
    if (!isSelf) {
      watchBtn = document.createElement('button');
      watchBtn.type = 'button';
      watchBtn.className = 'tile-btn tile-watch-btn';
      watchBtn.title = 'Stop watching';
      watchBtn.setAttribute('aria-label', 'Stop watching');
      watchBtn.innerHTML = WATCHING_ICON;

      watchBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const currentWatching = state.peerWatching.get(tileKey) !== false;
        setTileWatching(tileKey, !currentWatching);
      });

      buttons.appendChild(watchBtn);
    }

    // Fullscreen button
    const fullBtn = document.createElement('button');
    fullBtn.className = 'tile-btn';
    fullBtn.title = 'Fullscreen';
    fullBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3' +
      'M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>' +
      '<span class="sr-only">Fullscreen</span>';
    fullBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    });

    buttons.appendChild(fullBtn);
    caption.append(label, buttons);
    root.appendChild(caption);

    // One click anywhere on the tile focuses it, and another gives the grid back.
    root.addEventListener('click', () => toggleFocus(tileKey));

    slot.appendChild(root);
    el.grid.appendChild(slot);

    tile = {
      tileKey,
      peerId: actualPeerId,
      kind: kind || 'screen',
      slot,
      root,
      video,
      label,
      pausedOverlay,
      pausedAvatar,
      pausedName,
      watchBtn,
      volumeBtn,
      volumeSlider,
      updateVolumeUI: () => {
        if (!volumeBtn || !volumeSlider) return;
        const data = getPeerVolume(actualPeerId);
        const displayVol = data.muted ? 0 : Math.round(data.volume * 100);
        volumeSlider.value = String(displayVol);

        if (data.muted || data.volume === 0) {
          volumeBtn.innerHTML = VOLUME_MUTED_ICON;
          volumeBtn.title = 'Unmute stream';
        } else if (data.volume <= 0.5) {
          volumeBtn.innerHTML = VOLUME_LOW_ICON;
          volumeBtn.title = 'Mute stream';
        } else {
          volumeBtn.innerHTML = VOLUME_HIGH_ICON;
          volumeBtn.title = 'Mute stream';
        }
      }
    };

    if (tile.updateVolumeUI) tile.updateVolumeUI();

    state.tiles.set(tileKey, tile);
    updateEmptyState();
    return tile;
  }

  function updateSelfTiles() {
    if (!state.signal) return;
    const selfId = state.signal.selfId;
    const selfName = state.signal.self?.name || AstraProfile.getName() || 'Guest';
    const selfLabel = `${selfName} (You)`;

    // Screen tile
    const screenKey = tileKey(selfId, 'screen');
    if (state.sharing && state.videoTrack && state.videoTrack.readyState === 'live') {
      const tile = tileFor(screenKey, selfLabel, selfId, 'screen');
      tile.root.classList.add('self');
      tile.root.classList.remove('is-camera');
      tile.label.textContent = selfLabel;
      if (!tile.video.srcObject || tile.video.srcObject.getVideoTracks()[0] !== state.videoTrack) {
        tile.video.srcObject = new MediaStream([state.videoTrack]);
        tile.video.play().catch(() => {});
      }
    } else {
      removeTile(screenKey);
    }

    // Camera tile
    const cameraKey = tileKey(selfId, 'camera');
    if (state.cameraOn && state.cameraTrack && state.cameraTrack.readyState === 'live') {
      const tile = tileFor(cameraKey, selfLabel, selfId, 'camera');
      tile.root.classList.add('self', 'is-camera');
      tile.label.textContent = selfLabel;
      if (!tile.video.srcObject || tile.video.srcObject.getVideoTracks()[0] !== state.cameraTrack) {
        tile.video.srcObject = new MediaStream([state.cameraTrack]);
        tile.video.play().catch(() => {});
      }
    } else {
      removeTile(cameraKey);
    }

    if (state.tiles.has(selfId)) {
      removeTile(selfId);
    }

    updateEmptyState();
  }

  /** Show remote tile(s) when that peer has live video, hide otherwise. */
  function refreshPeerTiles(id) {
    if (!state.signal || id === state.signal.selfId) return;
    const peer = state.signal.roster.get(id);
    const peerName = peer ? peer.name : 'Guest';

    let trackSet = state.remoteVideoTracks.get(id);
    const stream = state.remote.get(id);
    if (stream) {
      if (!trackSet) {
        trackSet = new Set();
        state.remoteVideoTracks.set(id, trackSet);
      }
      for (const t of stream.getVideoTracks()) {
        trackSet.add(t);
      }
    }

    if (trackSet) {
      for (const t of trackSet) {
        if (t.readyState === 'ended') trackSet.delete(t);
      }
    }

    const liveTracks = trackSet ? Array.from(trackSet).filter((t) => t.readyState === 'live') : [];

    const wantsSharing = !!(peer && peer.sharing);
    const wantsCamera = !!(peer && peer.camera);

    if (!wantsSharing && !wantsCamera && liveTracks.length === 0) {
      for (const kind of TILE_KINDS) removeTile(tileKey(id, kind));
      removeTile(id);
      updateEmptyState();
      return;
    }

    let screenTrack = null;
    let cameraTrack = null;

    if (liveTracks.length === 1) {
      const track = liveTracks[0];
      if (wantsCamera && !wantsSharing) {
        cameraTrack = track;
      } else if (wantsSharing && !wantsCamera) {
        screenTrack = track;
      } else if (peer && peer.cameraTrackId === track.id) {
        cameraTrack = track;
      } else if (peer && peer.screenTrackId === track.id) {
        screenTrack = track;
      } else if (wantsCamera) {
        cameraTrack = track;
      } else {
        screenTrack = track;
      }
    } else if (liveTracks.length >= 2) {
      for (const track of liveTracks) {
        if (peer && peer.cameraTrackId && track.id === peer.cameraTrackId) {
          cameraTrack = track;
        } else if (peer && peer.screenTrackId && track.id === peer.screenTrackId) {
          screenTrack = track;
        }
      }
      if (!cameraTrack && !screenTrack) {
        if (liveTracks[0].contentHint === 'detail') {
          screenTrack = liveTracks[0];
          cameraTrack = liveTracks[1];
        } else if (liveTracks[1].contentHint === 'detail') {
          screenTrack = liveTracks[1];
          cameraTrack = liveTracks[0];
        } else {
          screenTrack = liveTracks[0];
          cameraTrack = liveTracks[1];
        }
      } else if (!cameraTrack && screenTrack) {
        cameraTrack = liveTracks.find((t) => t !== screenTrack) || null;
      } else if (!screenTrack && cameraTrack) {
        screenTrack = liveTracks.find((t) => t !== cameraTrack) || null;
      }
    }

    const screenTileKey = tileKey(id, 'screen');
    if (screenTrack && wantsSharing !== false) {
      const tile = tileFor(screenTileKey, peerName, id, 'screen');
      tile.label.textContent = peerName;
      tile.root.classList.remove('is-camera');
      if (!tile.video.srcObject || tile.video.srcObject.getVideoTracks()[0] !== screenTrack) {
        tile.video.srcObject = new MediaStream([screenTrack]);
        tile.video.play().catch(() => {});
      }
      const isWatching = state.peerWatching.get(screenTileKey) !== false;
      setTileWatching(screenTileKey, isWatching);
    } else if (!wantsSharing) {
      removeTile(screenTileKey);
    }

    const cameraTileKey = tileKey(id, 'camera');
    if (cameraTrack && wantsCamera !== false) {
      const tile = tileFor(cameraTileKey, peerName, id, 'camera');
      tile.label.textContent = peerName;
      tile.root.classList.add('is-camera');
      if (!tile.video.srcObject || tile.video.srcObject.getVideoTracks()[0] !== cameraTrack) {
        tile.video.srcObject = new MediaStream([cameraTrack]);
        tile.video.play().catch(() => {});
      }
      const isWatching = state.peerWatching.get(cameraTileKey) !== false;
      setTileWatching(cameraTileKey, isWatching);
    } else if (!wantsCamera) {
      removeTile(cameraTileKey);
    }

    if (state.tiles.has(id)) {
      removeTile(id);
    }

    updateEmptyState();
  }

  function removeTile(tileKey) {
    const tile = state.tiles.get(tileKey);
    if (!tile) return;
    tile.video.srcObject = null;
    tile.slot.remove();
    state.tiles.delete(tileKey);
    state.peerWatching.delete(tileKey);
    if (state.focused === tileKey) toggleFocus(tileKey);
    updateEmptyState();
  }

  function toggleFocus(tileKey) {
    const wasFocused = state.focused === tileKey;
    state.focused = wasFocused ? null : tileKey;
    el.grid.classList.toggle('has-focus', !!state.focused);
    for (const [key, tile] of state.tiles) {
      tile.slot.classList.toggle('focused', key === state.focused);
    }
  }

  function updateEmptyState() {
    el.empty.hidden = state.tiles.size > 0;
    // Drives the share-out rules in the stylesheet: 1 fills, 2 stack, 3 is a
    // pair over a centred tile, 4 is a 2x2, and so on.
    el.grid.dataset.count = String(Math.min(state.tiles.size, 9));
  }

  // ------------------------------------------------ voice activity detection
  const vad = {
    analysers: new Map(), // peerId or 'self' -> { source, analyser, data, silentGain }
    lastSpoke: new Map(), // peerId or 'self' -> timestamp
    timer: null,

    attach(id, stream) {
      this.detach(id);
      if (!stream || !state.mixer || !state.mixer.ctx) return;
      try {
        const ctx = state.mixer.ctx;
        const tracks = stream.getAudioTracks();
        if (tracks.length === 0) return;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);

        // Keep audio graph active across all browsers
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        analyser.connect(silentGain);
        silentGain.connect(ctx.destination);

        const data = new Uint8Array(analyser.frequencyBinCount);
        this.analysers.set(id, { source, analyser, data, silentGain });
        this.start();
      } catch (err) {
        console.warn('VAD attach failed for ' + id, err);
      }
    },

    detach(id) {
      const entry = this.analysers.get(id);
      if (entry) {
        try {
          entry.source.disconnect();
          entry.analyser.disconnect();
          entry.silentGain.disconnect();
        } catch (_) {}
        this.analysers.delete(id);
      }
      this.lastSpoke.delete(id);
      const actualId = id === 'self' ? state.signal?.selfId : id;
      if (actualId) setSpeaking(actualId, false);
      if (this.analysers.size === 0) this.stop();
    },

    stop() {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = null;
    },

    start() {
      if (this.timer) return;
      // The speaking ring holds for 350ms, so sampling faster than this buys
      // nothing visible - and it only drives rings, which cannot be seen while
      // the tab is hidden, so it stops entirely there.
      if (document.hidden) return;
      this.timer = setInterval(() => this.poll(), 100);
    },

    poll() {
      const now = Date.now();
      for (const [id, entry] of this.analysers) {
        const actualId = id === 'self' ? state.signal?.selfId : id;
        if (!actualId) continue;

        if (id === 'self') {
          if (!state.micOn) {
            setSpeaking(actualId, false);
            continue;
          }
        } else {
          const peer = state.signal?.roster.get(actualId);
          if (!peer || !peer.mic) {
            setSpeaking(actualId, false);
            continue;
          }
        }

        entry.analyser.getByteFrequencyData(entry.data);
        let sum = 0;
        let count = 0;
        const maxBin = Math.min(entry.data.length, 64);
        for (let i = 1; i < maxBin; i++) {
          sum += entry.data[i];
          count++;
        }
        const avg = sum / (count || 1);
        if (avg > 14) {
          this.lastSpoke.set(id, now);
        }

        const speaking = (now - (this.lastSpoke.get(id) || 0)) < 350;
        setSpeaking(actualId, speaking);
      }
    },

    destroy() {
      this.stop();
      for (const id of Array.from(this.analysers.keys())) {
        this.detach(id);
      }
    }
  };

  // start() refuses to run while the tab is hidden, so it has to be woken when
  // the tab comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) vad.stop();
    else if (vad.analysers.size) vad.start();
  });

  function setSpeaking(peerId, speaking) {
    if (!peerId) return;
    const wasSpeaking = state.speakingPeers.has(peerId);
    if (wasSpeaking === speaking) return;
    if (speaking) {
      state.speakingPeers.add(peerId);
    } else {
      state.speakingPeers.delete(peerId);
    }
    const avatar = state.peopleAvatars.get(peerId);
    if (avatar) {
      avatar.classList.toggle('is-speaking', speaking);
      if (avatar.parentElement) {
        avatar.parentElement.classList.toggle('is-speaking', speaking);
      }
    }
    if (activePopupPeerId === peerId && el.profilePopupAvatar) {
      el.profilePopupAvatar.classList.toggle('is-speaking', speaking);
    }
  }

  // -------------------------------------------------------------- remote audio

  function attachAudio(id, stream) {
    let audio = state.audios.get(id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.className = 'sr-only';
      document.body.appendChild(audio);
      state.audios.set(id, audio);
    }
    const vol = getPeerVolume(id);
    audio.volume = vol.muted ? 0 : vol.volume;
    audio.muted = state.deafened || vol.muted;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.play().catch(() => {
      // Autoplay policy can still bite; offer a button to unblock every element.
      el.enableAudio.hidden = false;
    });
    vad.attach(id, stream);
  }

  el.enableAudio.addEventListener('click', async () => {
    await state.mixer.resume();
    for (const audio of state.audios.values()) {
      try {
        await audio.play();
      } catch (_) {
        /* keep trying the rest */
      }
    }
    el.enableAudio.hidden = true;
  });

  function dropPeerMedia(id) {
    for (const kind of TILE_KINDS) removeTile(tileKey(id, kind));
    removeTile(id);
    state.remoteVideoTracks.delete(id);
    state.remote.delete(id);
    const audio = state.audios.get(id);
    if (audio) {
      audio.srcObject = null;
      audio.remove();
      state.audios.delete(id);
    }
    vad.detach(id);
    state.peerVolumes.delete(id);
    for (const kind of TILE_KINDS) state.peerWatching.delete(tileKey(id, kind));
    state.peerWatching.delete(id);
  }

  // ---------------------------------------------------------------- room UI

  /**
   * Reconcile the people list against the roster.
   *
   * This runs on every roster event - somebody muting, sharing, joining or
   * chatting - so it patches the rows that actually changed instead of
   * rebuilding all of them (which also re-decoded every avatar).
   */
  function renderPeople() {
    const roster = Array.from(state.signal.roster.values());
    const seen = new Set();

    roster.forEach((peer, index) => {
      seen.add(peer.id);
      let row = state.peopleRows.get(peer.id);
      if (!row) {
        row = createPersonRow(peer);
        state.peopleRows.set(peer.id, row);
        state.peopleAvatars.set(peer.id, row.avatar);
      }
      updatePersonRow(row, peer);

      // Keep the DOM in roster order without touching rows already in place.
      if (el.people.children[index] !== row.item) {
        el.people.insertBefore(row.item, el.people.children[index] || null);
      }
    });

    for (const [id, row] of state.peopleRows) {
      if (seen.has(id)) continue;
      if (activePopupPeerId === id && typeof closeProfilePopup === 'function') {
        closeProfilePopup();
      }
      row.item.remove();
      state.peopleRows.delete(id);
      state.peopleAvatars.delete(id);
    }
  }

  const NAMEPLATE_GRADIENT =
    'linear-gradient(90deg, rgba(14, 14, 18, 0.82) 0%, rgba(14, 14, 18, 0.65) 32%, rgba(14, 14, 18, 0.28) 65%, transparent 100%)';

  /** The parts of a row that never change once it exists. */
  function createPersonRow(peer) {
    const isSelf = peer.id === state.signal.selfId;
    const item = document.createElement('li');

    const nameplate = document.createElement('div');
    nameplate.className = 'person-nameplate';
    nameplate.setAttribute('aria-hidden', 'true');
    nameplate.hidden = true;

    const avatar = document.createElement('span');
    avatar.dataset.peer = peer.id;

    const name = document.createElement('span');
    name.className = 'person-name';

    const tags = document.createElement('span');
    tags.className = 'person-tags';

    item.append(nameplate, avatar, name, tags);

    item.addEventListener('click', (e) => {
      if (e.target.closest('.tag-danger')) return;
      if (typeof openProfilePopup === 'function') {
        openProfilePopup(peer.id, item);
      }
    });

    return { item, avatar, name, tags, nameplate, isSelf, tagKey: null, bannerKey: null, hasBanner: false };
  }

  function updatePersonRow(row, peer) {
    const isSpeaking = state.speakingPeers.has(peer.id);
    const banner = (row.isSelf ? (AstraProfile.getBanner() || peer.banner) : peer.banner) || null;
    if (row.bannerKey !== banner) {
      row.bannerKey = banner;
      row.hasBanner = !!banner && AstraProfile.isBanner(banner);
      if (row.hasBanner) {
        row.nameplate.style.backgroundImage = NAMEPLATE_GRADIENT + ', url(' + banner + ')';
        row.nameplate.hidden = false;
      } else {
        row.nameplate.style.backgroundImage = '';
        row.nameplate.hidden = true;
      }
    }
    row.item.className =
      'person' + (isSpeaking ? ' is-speaking' : '') + (row.hasBanner ? ' has-banner' : '');
    row.avatar.className = 'avatar' + (isSpeaking ? ' is-speaking' : '');
    AstraProfile.paint(row.avatar, peer.name, peer.avatar);

    const label = peer.name + (row.isSelf ? ' (you)' : '');
    if (row.name.textContent !== label) row.name.textContent = label;

    const expectedLabel = row.isSelf ? `${peer.name} (You)` : peer.name;
    for (const kind of TILE_KINDS) {
      const tile = state.tiles.get(tileKey(peer.id, kind));
      if (!tile) continue;
      if (tile.pausedOverlay && !tile.pausedOverlay.hidden) {
        if (tile.pausedName) tile.pausedName.textContent = peer.name;
        if (tile.pausedAvatar) AstraProfile.paint(tile.pausedAvatar, peer.name, peer.avatar);
      }
      if (tile.label && tile.label.textContent !== expectedLabel) {
        tile.label.textContent = expectedLabel;
      }
    }

    if (activePopupPeerId === peer.id && el.profilePopup && !el.profilePopup.hidden && typeof renderPopupContent === 'function') {
      renderPopupContent(peer.id);
    }

    // Badges are cheap to compare and comparatively costly to build.
    const isDevPeer = row.isSelf ? !!(window.AstraDiscord && window.AstraDiscord.isDev()) : !!peer.dev;
    const canKick = !row.isSelf && !!state.signal?.self?.host;
    const isSharing = row.isSelf ? !!state.sharing : !!peer.sharing;
    const isCamera = row.isSelf ? !!state.cameraOn : !!peer.camera;
    const isMic = row.isSelf ? !!state.micOn : !!peer.mic;
    const isDeafened = row.isSelf ? !!state.deafened : !!peer.deafened;
    const tagKey = [peer.host, isDevPeer, isSharing, isCamera, isDeafened, isMic, canKick, peer.name].join('|');
    if (row.tagKey === tagKey) return;
    row.tagKey = tagKey;

    row.tags.textContent = '';
    if (peer.host) row.tags.appendChild(tag('HOST', 'tag-host'));
    if (isDevPeer) row.tags.appendChild(devTag());
    if (isSharing) row.tags.appendChild(iconTag(PEOPLE_ICONS.sharing));
    if (isCamera) row.tags.appendChild(iconTag(PEOPLE_ICONS.camera));
    if (isDeafened) row.tags.appendChild(iconTag(PEOPLE_ICONS.deafened));
    else if (!isMic) row.tags.appendChild(iconTag(PEOPLE_ICONS.micMuted));
    if (canKick) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'tag tag-danger';
      kick.textContent = 'kick';
      kick.title = 'Kick ' + peer.name;
      kick.addEventListener('click', () => {
        if (confirm('Kick ' + peer.name + ' from the room?')) state.signal.kick(peer.id);
      });
      row.tags.appendChild(kick);
    }
  }

  // Status glyphs for the people list. One builder, one table of shapes.
  const PEOPLE_ICONS = {
    sharing: {
      cls: 'tag-sharing',
      title: 'Sharing screen',
      paths:
        '<rect x="2" y="4" width="20" height="13" rx="2" />' +
        '<path d="M8 21h8M12 17v4M12 13.5V7m0 0L9.6 9.4M12 7l2.4 2.4" />',
    },
    camera: {
      cls: 'tag-camera',
      title: 'Camera on',
      paths:
        '<path d="M22.5 7.5l-6 4.5 6 4.5V7.5z" />' +
        '<rect x="2.5" y="5" width="14" height="14" rx="2" ry="2" />',
    },
    micMuted: {
      cls: 'tag-mic-muted',
      title: 'Microphone muted',
      paths:
        '<line x1="2" y1="2" x2="22" y2="22" />' +
        '<path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />' +
        '<path d="M5 10v2a7 7 0 0 0 10.5 6.07" />' +
        '<path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />' +
        '<path d="M9 9v3a3 3 0 0 0 5.12 2.12" />' +
        '<line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />',
    },
    deafened: {
      cls: 'tag-deafened',
      title: 'Deafened',
      paths:
        '<path d="M3 18v-6a9 9 0 0 1 18 0v6" />' +
        '<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />' +
        '<line x1="2" y1="2" x2="22" y2="22" stroke-width="2.2" />',
    },
  };

  function iconTag(icon) {
    const span = document.createElement('span');
    span.className = 'tag-icon ' + icon.cls;
    span.title = icon.title;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const attrs = {
      viewBox: '0 0 24 24',
      width: '18',
      height: '18',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    };
    for (const name of Object.keys(attrs)) svg.setAttribute(name, attrs[name]);
    svg.innerHTML = icon.paths;
    span.appendChild(svg);
    return span;
  }

  function tag(text, extra) {
    const span = document.createElement('span');
    span.className = 'tag' + (extra ? ' ' + extra : '');
    span.textContent = text;
    return span;
  }

  const DEV_TAG_ICON_SVG =
    '<svg class="tag-dev-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 8.5L4.5 12L8 15.5"/>' +
    '<path d="M16 8.5L19.5 12L16 15.5"/>' +
    '<path d="M13.5 6L10.5 18"/>' +
    '</svg>';

  const devTagTemplate = (() => {
    const span = document.createElement('span');
    span.className = 'tag tag-dev';
    span.title = 'Developer';
    span.setAttribute('aria-label', 'Developer');
    span.innerHTML = DEV_TAG_ICON_SVG;
    return span;
  })();

  function devTag() {
    return devTagTemplate.cloneNode(true);
  }

  el.copyLink.addEventListener('click', async () => {
    const link = location.origin + location.pathname + '?room=' + state.signal.code;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch (_) {
      prompt('Copy this link:', link);
    }
  });

  // ------------------------------------------------ In-Room Profile Pop-up

  let activePopupPeerId = null;
  let activePopupAnchor = null;
  let lastPopupTagKey = null;
  let lastPopupDev = null;

  function closeProfilePopup() {
    if (!el.profilePopup || el.profilePopup.hidden) return;
    el.profilePopup.hidden = true;
    activePopupPeerId = null;
    activePopupAnchor = null;
    lastPopupTagKey = null;
    lastPopupDev = null;
    document.removeEventListener('keydown', handlePopupKey);
  }

  function handlePopupKey(e) {
    if (e.key === 'Escape') closeProfilePopup();
  }

  function updatePopupVolumeUI(peerId) {
    if (!el.profilePopupVolumeSlider || !el.profilePopupVolumeVal || !el.profilePopupVolumeMute) return;
    const volData = getPeerVolume(peerId);
    const displayVol = volData.muted ? 0 : Math.round(volData.volume * 100);
    el.profilePopupVolumeSlider.value = String(displayVol);
    el.profilePopupVolumeVal.textContent = displayVol + '%';

    if (volData.muted || volData.volume === 0) {
      el.profilePopupVolumeMute.innerHTML = VOLUME_MUTED_ICON;
      el.profilePopupVolumeMute.title = 'Unmute user';
    } else if (volData.volume <= 0.5) {
      el.profilePopupVolumeMute.innerHTML = VOLUME_LOW_ICON;
      el.profilePopupVolumeMute.title = 'Mute user';
    } else {
      el.profilePopupVolumeMute.innerHTML = VOLUME_HIGH_ICON;
      el.profilePopupVolumeMute.title = 'Mute user';
    }
  }

  function renderPopupContent(peerId) {
    const isSelf = peerId === state.signal?.selfId;
    let name = 'Guest';
    let avatarData = null;
    let bannerData = null;
    let isHost = false;
    let isDevUser = false;
    let isSharing = false;
    let isCamera = false;
    let isMic = false;
    let isDeafened = false;

    if (isSelf) {
      name = AstraProfile.getName() || 'Guest';
      avatarData = AstraProfile.getAvatar();
      bannerData = AstraProfile.getBanner();
      isHost = !!state.signal?.self?.host;
      isDevUser = !!(window.AstraDiscord && window.AstraDiscord.isDev());
      isSharing = !!state.sharing;
      isCamera = !!state.cameraOn;
      isMic = !!state.micOn;
      isDeafened = !!state.deafened;
    } else {
      const peer = state.signal?.roster?.get(peerId);
      if (!peer) {
        closeProfilePopup();
        return;
      }
      name = peer.name || 'Guest';
      avatarData = peer.avatar;
      bannerData = peer.banner;
      isHost = !!peer.host;
      isDevUser = !!peer.dev;
      isSharing = !!peer.sharing;
      isCamera = !!peer.camera;
      isMic = !!peer.mic;
      isDeafened = !!peer.deafened;
    }

    AstraProfile.paintBanner(el.profilePopupBanner, bannerData, name);
    AstraProfile.paint(el.profilePopupAvatar, name, avatarData);
    el.profilePopupAvatar.classList.toggle('is-speaking', state.speakingPeers.has(peerId));

    const nameLabel = name + (isSelf ? ' (you)' : '');
    if (el.profilePopupName.textContent !== nameLabel) {
      el.profilePopupName.textContent = nameLabel;
    }

    // Badges: avoid rebuilding DOM if status flags haven't changed
    const tagKey = [isHost, isSharing, isCamera, isDeafened, isMic].join('|');
    if (lastPopupTagKey !== tagKey) {
      lastPopupTagKey = tagKey;
      el.profilePopupBadges.textContent = '';
      if (isHost) el.profilePopupBadges.appendChild(tag('HOST', 'tag-host'));
      if (isSharing) el.profilePopupBadges.appendChild(iconTag(PEOPLE_ICONS.sharing));
      if (isCamera) el.profilePopupBadges.appendChild(iconTag(PEOPLE_ICONS.camera));
      if (isDeafened) el.profilePopupBadges.appendChild(iconTag(PEOPLE_ICONS.deafened));
      else if (!isMic) el.profilePopupBadges.appendChild(iconTag(PEOPLE_ICONS.micMuted));
    }

    // User badges (Developer) right next to profile picture
    if (el.profilePopupUserBadges && lastPopupDev !== isDevUser) {
      lastPopupDev = isDevUser;
      el.profilePopupUserBadges.textContent = '';
      if (isDevUser && window.AstraDiscord) {
        el.profilePopupUserBadges.appendChild(window.AstraDiscord.createDevBadge('Developer'));
        el.profilePopupUserBadges.hidden = false;
      } else {
        el.profilePopupUserBadges.hidden = true;
      }
    }

    // Discord info
    if (isSelf && window.AstraDiscord) {
      const user = window.AstraDiscord.getUser();
      if (user && user.username) {
        const discordLabel = '@' + (user.global_name ? `${user.global_name} (${user.username})` : user.username);
        if (el.profilePopupDiscordUser.textContent !== discordLabel) {
          el.profilePopupDiscordUser.textContent = discordLabel;
        }
        el.profilePopupDiscord.hidden = false;
      } else {
        el.profilePopupDiscord.hidden = true;
      }
    } else {
      el.profilePopupDiscord.hidden = true;
    }

    // Volume section (remote peers only)
    if (!isSelf) {
      el.profilePopupVolumeSection.hidden = false;
      updatePopupVolumeUI(peerId);
    } else {
      el.profilePopupVolumeSection.hidden = true;
    }

    // Actions
    if (isSelf) {
      el.profilePopupEditBtn.hidden = false;
      el.profilePopupKickBtn.hidden = true;
    } else {
      el.profilePopupEditBtn.hidden = true;
      const canKick = !!state.signal?.self?.host;
      el.profilePopupKickBtn.hidden = !canKick;
    }
  }

  function positionProfilePopup(anchorEl) {
    if (!el.profilePopupCard || !anchorEl) return;

    if (window.innerWidth <= 860) {
      el.profilePopupCard.style.left = '50%';
      el.profilePopupCard.style.top = '50%';
      el.profilePopupCard.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const rect = anchorEl.getBoundingClientRect();
    const popupWidth = 290;
    let left = rect.left - popupWidth - 12;
    if (left < 10) left = Math.max(10, rect.right + 12);
    left = Math.min(left, window.innerWidth - popupWidth - 10);

    let top = rect.top - 20;
    const estimatedHeight = el.profilePopupCard.offsetHeight || 320;
    const maxTop = window.innerHeight - estimatedHeight - 16;
    top = Math.max(16, Math.min(top, maxTop));

    el.profilePopupCard.style.left = `${left}px`;
    el.profilePopupCard.style.top = `${top}px`;
    el.profilePopupCard.style.transform = 'none';
  }

  function openProfilePopup(peerId, anchorEl) {
    if (!el.profilePopup || !anchorEl) return;
    if (activePopupPeerId === peerId && !el.profilePopup.hidden) {
      closeProfilePopup();
      return;
    }

    if (activePopupPeerId !== peerId) {
      lastPopupTagKey = null;
      lastPopupDev = null;
    }
    activePopupPeerId = peerId;
    activePopupAnchor = anchorEl;

    renderPopupContent(peerId);
    positionProfilePopup(anchorEl);

    el.profilePopup.hidden = false;
    document.removeEventListener('keydown', handlePopupKey);
    document.addEventListener('keydown', handlePopupKey);
  }

  function setupProfilePopup() {
    if (!el.profilePopup) return;

    el.profilePopupClose.addEventListener('click', closeProfilePopup);
    el.profilePopupBackdrop.addEventListener('click', closeProfilePopup);

    el.profilePopupEditBtn.addEventListener('click', () => {
      closeProfilePopup();
      openProfileModal();
    });

    el.profilePopupKickBtn.addEventListener('click', () => {
      if (!activePopupPeerId) return;
      const peer = state.signal?.roster?.get(activePopupPeerId);
      const name = peer ? peer.name : 'this user';
      if (confirm('Kick ' + name + ' from the room?')) {
        state.signal.kick(activePopupPeerId);
        closeProfilePopup();
      }
    });

    if (el.profilePopupVolumeSlider) {
      el.profilePopupVolumeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        if (!activePopupPeerId) return;
        const val = parseFloat(el.profilePopupVolumeSlider.value) / 100;
        setPeerVolume(activePopupPeerId, val, val === 0);
        updatePopupVolumeUI(activePopupPeerId);
      });
    }

    if (el.profilePopupVolumeMute) {
      el.profilePopupVolumeMute.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activePopupPeerId) return;
        const cur = getPeerVolume(activePopupPeerId);
        if (cur.muted) {
          const restore = cur.volume > 0 ? cur.volume : 1.0;
          setPeerVolume(activePopupPeerId, restore, false);
        } else {
          setPeerVolume(activePopupPeerId, cur.volume, true);
        }
        updatePopupVolumeUI(activePopupPeerId);
      });
    }
  }

  setupProfilePopup();

  // -------------------------------------------------------------------- chat

  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    state.signal.chat(text);
    el.chatInput.value = '';
  });

  function addMessage(message) {
    const isMine = message.id === state.signal.selfId;
    const item = document.createElement('li');
    item.className = 'message' + (isMine ? ' mine' : '');

    const avatar = document.createElement('span');
    avatar.className = 'avatar message-avatar';
    const peer = state.signal.roster.get(message.id);
    const avatarData = message.avatar || (peer ? peer.avatar : null) || (isMine ? (state.signal.self?.avatar || AstraProfile.getAvatar()) : null);
    AstraProfile.paint(avatar, message.name, avatarData);

    const content = document.createElement('div');
    content.className = 'message-content';

    const who = document.createElement('span');
    who.className = 'message-who';
    who.textContent = message.name;

    const body = document.createElement('span');
    body.className = 'message-body';
    body.textContent = message.text;

    content.append(who, body);
    item.append(avatar, content);
    el.messages.appendChild(item);
    el.messages.scrollTop = el.messages.scrollHeight;

    if (el.chatPanel.hidden) {
      el.toggleChat.classList.add('chip-accent');
      toast(message.name + ': ' + message.text);
    }
  }

  el.togglePeople.addEventListener('click', () => togglePanel(el.peoplePanel, el.togglePeople));
  el.toggleChat.addEventListener('click', () => {
    togglePanel(el.chatPanel, el.toggleChat);
    el.toggleChat.classList.remove('chip-accent');
    if (!el.chatPanel.hidden) el.chatInput.focus();
  });

  function togglePanel(panel, button) {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-pressed', String(!panel.hidden));
    syncPanels();
  }

  function syncPanels() {
    el.sidebar.hidden = el.peoplePanel.hidden && el.chatPanel.hidden;
    // Give the column back to the stage when nothing is in it.
    document.body.classList.toggle('sidebar-hidden', el.sidebar.hidden);
    // The split handle - and the split itself - only mean something with both
    // panels open.
    const split = !el.peoplePanel.hidden && !el.chatPanel.hidden;
    el.resizeY.hidden = !split;
    el.sidebar.classList.toggle('split', split);
  }

  // ------------------------------------------------------------- resizing

  function loadLayout() {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function saveLayout(patch) {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(Object.assign(loadLayout(), patch)));
    } catch (_) {
      /* private mode - the layout just will not persist */
    }
  }

  function clampSidebar(width) {
    const max = Math.max(240, Math.min(640, window.innerWidth - 360));
    return Math.round(Math.min(Math.max(width, 220), max));
  }

  function setPeopleShare(ratio) {
    const clamped = Math.min(Math.max(ratio, 0.15), 0.85);
    document.body.style.setProperty('--people-flex', String(clamped));
    document.body.style.setProperty('--chat-flex', String(1 - clamped));
    return clamped;
  }

  function applyLayout() {
    const saved = loadLayout();
    if (saved.sidebar) {
      document.body.style.setProperty('--sidebar-w', clampSidebar(saved.sidebar) + 'px');
    }
    if (saved.peopleShare) setPeopleShare(saved.peopleShare);
  }

  /** Shared plumbing for both handles: capture the pointer, drag, then save. */
  function onDrag(handle, start) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      event.preventDefault();
      const move = start(event);
      if (!move) return;

      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_) {
        // Capture is an optimisation; the drag still works without it.
      }
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.style.setProperty(
        '--resize-cursor',
        handle === el.resizeY ? 'row-resize' : 'col-resize'
      );

      const onMove = (e) => move.drag(e);
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        move.done();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  }

  onDrag(el.resizeX, (event) => {
    const startX = event.clientX;
    const startWidth = el.sidebar.getBoundingClientRect().width;
    return {
      // The sidebar is on the right, so dragging left widens it.
      drag: (e) =>
        document.body.style.setProperty(
          '--sidebar-w',
          clampSidebar(startWidth - (e.clientX - startX)) + 'px'
        ),
      done: () => saveLayout({ sidebar: el.sidebar.getBoundingClientRect().width }),
    };
  });

  onDrag(el.resizeY, (event) => {
    const startY = event.clientY;
    const peopleHeight = el.peoplePanel.getBoundingClientRect().height;
    const total = peopleHeight + el.chatPanel.getBoundingClientRect().height;
    if (total <= 0) return null;
    let share = peopleHeight / total;
    return {
      drag: (e) => {
        share = setPeopleShare((peopleHeight + (e.clientY - startY)) / total);
      },
      done: () => saveLayout({ peopleShare: share }),
    };
  });

  // A window that shrank can leave the sidebar wider than the room allows.
  window.addEventListener('resize', () => {
    const width = el.sidebar.getBoundingClientRect().width;
    if (width) document.body.style.setProperty('--sidebar-w', clampSidebar(width) + 'px');
    if (activePopupAnchor && el.profilePopup && !el.profilePopup.hidden) {
      positionProfilePopup(activePopupAnchor);
    }
  });

  // ------------------------------------------------------------------- exits

  let localOfflineTimer = null;
  const LOCAL_OFFLINE_GRACE_MS = 25000;

  function showClosed(reason) {
    el.closedReason.textContent = reason || 'The room ended.';
    el.closed.hidden = false;
    teardown();
  }

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    closeProfilePopup();
    toggleShareMenu(false);
    toggleCameraMenu(false);
    if (cameraDeviceChangeTimer) {
      clearTimeout(cameraDeviceChangeTimer);
      cameraDeviceChangeTimer = null;
    }
    if (navigator.mediaDevices && typeof navigator.mediaDevices.removeEventListener === 'function') {
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }
    window.removeEventListener('resize', onCameraWindowResize);
    if (el.toggleProfile) el.toggleProfile.setAttribute('aria-pressed', 'false');
    if (el.profileModal) el.profileModal.hidden = true;
    if (localOfflineTimer) {
      clearTimeout(localOfflineTimer);
      localOfflineTimer = null;
    }
    if (state.mesh) state.mesh.close();
    cleanUpCapture();
    cleanUpCamera();
    stopStream(state.micStream);
    vad.destroy();
    if (state.mixer) state.mixer.close();
    for (const trackSet of state.remoteVideoTracks.values()) {
      trackSet.clear();
    }
    state.remoteVideoTracks.clear();
    for (const tile of state.tiles.values()) {
      if (tile.video) tile.video.srcObject = null;
      if (tile.slot) tile.slot.remove();
    }
    state.tiles.clear();
    for (const audio of state.audios.values()) {
      audio.srcObject = null;
      audio.remove();
    }
    state.audios.clear();
    state.remote.clear();
    state.peerWatching.clear();
    state.peerVolumes.clear();
    stopRoomApiHeartbeat();
  }

  /**
   * The single way out: tell the room, release the hardware, then head for the
   * lobby behind a short loading overlay so the room does not simply vanish
   * while the next page is still fetching.
   */
  function leaveForLobby() {
    if (leaving) return; // a double-click should not queue two navigations
    leaving = true;
    sendRoomExitBeacon();
    // Say goodbye now rather than at unload, so the others see it immediately.
    if (state.signal) state.signal.leave();
    teardown();
    el.leaving.hidden = false;
    setTimeout(() => { location.href = '../'; }, LEAVE_DELAY_MS);
  }

  el.leave.addEventListener('click', leaveForLobby);

  window.addEventListener('pagehide', () => {
    sendRoomExitBeacon();
    if (state.signal) state.signal.leave();
  });

  window.addEventListener('offline', () => {
    if (tornDown || leaving) return;
    toast('Network connection lost. Reconnecting…', 'bad');
    if (localOfflineTimer) clearTimeout(localOfflineTimer);
    localOfflineTimer = setTimeout(() => {
      if (!navigator.onLine && !tornDown && !leaving) {
        showClosed('Disconnected: your network connection was lost.');
      }
    }, LOCAL_OFFLINE_GRACE_MS);
  });

  window.addEventListener('online', () => {
    if (localOfflineTimer) {
      clearTimeout(localOfflineTimer);
      localOfflineTimer = null;
    }
    if (!tornDown && !leaving) {
      toast('Network connection restored.');
      if (state.signal && state.signal.peer && !state.signal.peer.destroyed && state.signal.peer.disconnected) {
        try { state.signal.peer.reconnect(); } catch (_) {}
      }
    }
  });

  el.backToStart.addEventListener('click', leaveForLobby);

  // The status bar is gone with the redesign: say it in a toast, and keep the
  // live region for screen readers.
  function setStatus(text, kind) {
    el.status.textContent = text;
    toast(text, kind);
  }

  function toast(text, kind) {
    if (!text || !el.toasts) return;

    // Check if identical toast message is already visible to prevent spam
    const existing = Array.from(el.toasts.querySelectorAll('.toast:not(.out)'));
    if (existing.some((node) => node.textContent === text)) {
      return;
    }

    // Limit to exactly 1 pop up: clear any existing toasts immediately
    el.toasts.textContent = '';

    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ' toast-' + kind : '');
    node.textContent = text;
    el.toasts.appendChild(node);
    setTimeout(() => node.classList.add('out'), 3200);
    setTimeout(() => node.remove(), 3600);
  }
})();
