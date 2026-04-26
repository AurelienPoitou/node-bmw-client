/* eslint require-atomic-updates : 0 */

// bluetooth-controller-globals.js
// Event-driven BlueZ ObjectManager scanner + controller for RPi4
// Assumes the following globals exist: log, update, status, config, IKE, MID, TEL
// Requires: dbus-next (npm install dbus-next)

const os = require('os');
const { systemBus } = require('dbus-next');

const bus = systemBus();

class BluetoothController {
  constructor() {
    // Discovered interface paths
    this.devicePath = null;
    this.playerPath = null;
    this.transportPath = null;

    // Cached properties
    this.deviceProps = {};
    this.playerProps = {};
    this.transportProps = {};

    // Waiters for async state transitions
    this.waiters = new Map();

    // Bind handlers
    this._onInterfacesAdded = this._onInterfacesAdded.bind(this);
    this._onInterfacesRemoved = this._onInterfacesRemoved.bind(this);
    this._onPropertiesChanged = this._onPropertiesChanged.bind(this);
  }

  // -------------------------
  // Public lifecycle
  // -------------------------
  async init() {
    // ensure a real MessageBus instance exists on the instance
    if (!this.bus) {
      this.bus = (
        typeof bus !== 'undefined'
          ? bus
          : (typeof systemBus !== 'undefined'
              ? systemBus()
              : require('dbus-next').systemBus())
      );
    }

    log.lib(
      '[bluetooth] DEBUG this.bus ready:',
      !!this.bus,
      'hasAddMatch:',
      !!(this.bus && this.bus.addMatch),
      'hasGetProxyObject:',
      !!(this.bus && this.bus.getProxyObject)
    );

    // ----------------------------------------------------
    // Subscribe to DBus signals
    // ----------------------------------------------------
    await this._subscribeObjectManager();
    log.lib('ObjectManager subscribed');

    await this._subscribePropertiesChanged();
    log.lib('PropertyChanges subscribed');

    // ----------------------------------------------------
    // Initial scan + populate
    // ----------------------------------------------------
    await this._scanManagedObjects();
    log.lib('ManagedObjects scanned');

    await this._populateInitialProperties();
    log.lib('InitialProperties populated');

    // ----------------------------------------------------
    // Retry discovery if devicePath not found
    // ----------------------------------------------------
    if (!this.devicePath) {
      for (let i = 0; i < 5 && !this.devicePath; i++) {
        await new Promise(r => setTimeout(r, 2000));
        await this._scanManagedObjects();
      }
    }

    // ----------------------------------------------------
    // Final LED update
    // ----------------------------------------------------
    this._updateLEDStatus();
    log.lib('BluetoothController initialized');
  }

  async recoverConnection() {
    log.lib('Recovering Bluetooth connection…');

    // ----------------------------------------------------
    // 1. Clean disconnect if we have a devicePath
    // ----------------------------------------------------
    if (this.devicePath) {
      try {
        log.lib('Attempting clean disconnect…');
        const obj = await this.bus.getProxyObject('org.bluez', this.devicePath);
        const dev = obj.getInterface('org.bluez.Device1');
        await dev.Disconnect().catch(() => {});
      } catch (e) {
        log.lib('Disconnect during recovery failed (ignored)');
      }
    }

    // ----------------------------------------------------
    // 2. Clear internal state
    // ----------------------------------------------------
    this.devicePath = null;
    this.playerPath = null;
    this.transportPath = null;
    this.deviceProps = {};
    this.playerProps = {};
    this.transportProps = {};

    update.status('bluetooth.device.connected', false);
    update.status('bluetooth.device.connecting', false);
    update.status('bluetooth.device.disconnecting', false);

    // ----------------------------------------------------
    // 3. Let BlueZ settle
    // ----------------------------------------------------
    await new Promise(r => setTimeout(r, 1500));

    // ----------------------------------------------------
    // 4. Rescan BlueZ objects
    // ----------------------------------------------------
    log.lib('Rescanning managed objects…');
    await this._scanManagedObjects();

    // Retry scan if device not found
    if (!this.devicePath) {
      for (let i = 0; i < 3 && !this.devicePath; i++) {
        await new Promise(r => setTimeout(r, 1500));
        await this._scanManagedObjects();
      }
    }

    if (!this.devicePath) {
      log.lib('Recovery failed: no device found after rescan');
      return false;
    }

    // ----------------------------------------------------
    // 5. Try to "wake" the phone by reading a property
    // ----------------------------------------------------
    try {
      const obj = await this.bus.getProxyObject('org.bluez', this.devicePath);
      const props = obj.getInterface('org.freedesktop.DBus.Properties');
      await props.Get('org.bluez.Device1', 'Name');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      // ignore — this is just a wake-up trick
    }

    // ----------------------------------------------------
    // 6. Multi-phase connect retry (car head-unit style)
    // ----------------------------------------------------
    const delays = [1000, 3000, 7000];

    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      try {
        log.lib(`Recovery connect attempt ${i + 1} (delay ${delay}ms)…`);
        await new Promise(r => setTimeout(r, delay));
        await this.connect();
        log.lib('Recovery succeeded');
        return true;
      } catch (err) {
        log.lib(`Recovery connect attempt ${i + 1} failed: ${err.message}`);
      }
    }

    // ----------------------------------------------------
    // 7. Final fallback: remove + re-pair (optional)
    // ----------------------------------------------------
    try {
      log.lib('Final fallback: removing device and re-pairing…');

      const obj = await this.bus.getProxyObject('org.bluez', this.devicePath);
      const dev = obj.getInterface('org.bluez.Device1');

      await dev.Remove().catch(() => {});
      await new Promise(r => setTimeout(r, 1500));

      // Rescan after removal
      this.devicePath = null;
      await this._scanManagedObjects();

      if (!this.devicePath) {
        log.lib('Device not found after removal — cannot re-pair');
        return false;
      }

      const obj2 = await this.bus.getProxyObject('org.bluez', this.devicePath);
      const dev2 = obj2.getInterface('org.bluez.Device1');

      await dev2.Pair();
      await new Promise(r => setTimeout(r, 1500));

      await dev2.Connect();
      log.lib('Recovery succeeded after re-pair');
      return true;

    } catch (e) {
      log.lib('Final fallback failed: ' + e.message);
    }

    log.lib('Recovery failed after all strategies');
    return false;
  }

  // -------------------------
  // Public commands
  // -------------------------
  async connect() {
    try {
      // ensure bus exists
      if (!this.bus) this.bus = (typeof bus !== 'undefined' ? bus : (typeof systemBus !== 'undefined' ? systemBus() : require('dbus-next').systemBus()));

      // If we don't have a device path, try to find and connect to the first paired device
      if (!this.devicePath) {
        update.status('bluetooth.device.connecting', true, false);
        const ok = await this.connectToFirstPairedDevice();
        update.status('bluetooth.device.connecting', false, false);
        if (!ok) {
          update.status('bluetooth.device.connected', false, false);
          log.lib('connect: no device could be connected');
          return;
        }
        // devicePath is set and device should be connected (or in progress)
      }

      // At this point we have a devicePath; check Connected property
      const obj = await this.bus.getProxyObject('org.bluez', this.devicePath);
      const props = obj.getInterface('org.freedesktop.DBus.Properties');
      const connectedProp = await props.Get('org.bluez.Device1', 'Connected');
      const alreadyConnected = !!(connectedProp && connectedProp.value === true);

      if (alreadyConnected) {
        log.lib(`connect: device already connected: ${this.devicePath}`);
        update.status('bluetooth.device.connected', true, false);
        update.status('bluetooth.device.connecting', false, false);
        this._updateLEDStatus();
        return;
      }

      // Not connected — initiate connection
      update.status('bluetooth.device.connecting', true, false);
      update.status('bluetooth.device.disconnecting', false, false);

      const dev = obj.getInterface('org.bluez.Device1');
      await dev.Connect();

      // Wait for Connected property to become true
      await this._waitForCondition('deviceConnected', () => !!(status.bluetooth && status.bluetooth.device && status.bluetooth.device.connected), 10000);

      update.status('bluetooth.device.connecting', false, false);
      update.status('bluetooth.device.connected', true, false);

      this._updateLEDStatus();
    } catch (err) {
      log.lib(`Connect failed: ${err && err.message ? err.message : err}`);
      update.status('bluetooth.device.connecting', false, false);

      // 🔥 Auto-recover on BlueZ connection failure
      if (err.message && err.message.includes('Input/output error')) {
        log.lib('Triggering recovery sequence…');
        await this.recoverConnection();
      }

      throw err;
    }
  }

  async forceAvrcpAndA2dp() {
    log.lib("[BT] Forcing AVRCP + A2DP activation…");

    const BLUEZ = {
      DEVICE_IFACE: "org.bluez.Device1",
      MEDIA_CONTROL_IFACE: "org.bluez.MediaControl1",
      MEDIA_PLAYER_IFACE: "org.bluez.MediaPlayer1",
      AVRCP_UUID: "0000110e-0000-1000-8000-00805f9b34fb"
    };

    // 1. Get Device1 interface
    const deviceObj = await this.bus.getProxyObject("org.bluez", this.devicePath);
    const device = deviceObj.getInterface(BLUEZ.DEVICE_IFACE);

    // 2. Try to connect AVRCP profile
    try {
      log.lib("[BT] Connecting AVRCP profile…");
      await device.ConnectProfile(BLUEZ.AVRCP_UUID);
    } catch (e) {
      log.lib("[BT] AVRCP ConnectProfile failed:", e.message);
    }

    // 3. Wait for MediaControl1 to appear
    let mediaControl = null;
    for (let i = 0; i < 20; i++) {
      try {
        const mcObj = await this.bus.getProxyObject("org.bluez", this.devicePath);
        mediaControl = mcObj.getInterface(BLUEZ.MEDIA_CONTROL_IFACE);
        break;
      } catch (_) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (!mediaControl) {
      log.lib("[BT] MediaControl1 not available.");
      return false;
    }

    // 4. Wait for MediaControl1.Connected = true
    for (let i = 0; i < 20; i++) {
      try {
        const props = await mediaControl.Get(BLUEZ.MEDIA_CONTROL_IFACE, "Connected");
        if (props.value === true) {
          log.lib("[BT] MediaControl1 connected.");
          break;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }

    // 5. Send Play() to trigger A2DP
    try {
      log.lib("[BT] Sending AVRCP Play()…");
      await mediaControl.Play();
    } catch (e) {
      log.lib("[BT] Play() failed:", e.message);
    }

    // 6. Wait for MediaPlayer1 to appear
    let player = null;
    for (let i = 0; i < 20; i++) {
      try {
        const mcObj = await this.bus.getProxyObject("org.bluez", this.devicePath);
        const props = mcObj.getInterface("org.freedesktop.DBus.Properties");
        const playerPath = (await props.Get(BLUEZ.MEDIA_CONTROL_IFACE, "Player")).value;

        if (playerPath && playerPath !== "/") {
          const pObj = await this.bus.getProxyObject("org.bluez", playerPath);
          player = pObj.getInterface(BLUEZ.MEDIA_PLAYER_IFACE);
          log.lib("[BT] MediaPlayer1 available:", playerPath);
          break;
        }
      } catch (_) {}

      await new Promise(r => setTimeout(r, 200));
    }

    if (!player) {
      log.lib("[BT] MediaPlayer1 not available.");
      return false;
    }

    log.lib("[BT] AVRCP + A2DP successfully activated.");
    return true;
  }

  async waitForServicesResolvedFalse() {
    return new Promise(async resolve => {
      const devObj = await this.bus.getProxyObject("org.bluez", this.devicePath);
      const props = devObj.getInterface("org.freedesktop.DBus.Properties");

      props.on("PropertiesChanged", (iface, changed) => {
        if (iface === "org.bluez.Device1" && changed.ServicesResolved !== undefined) {
          const value = changed.ServicesResolved.value;
          if (value === false) {
            console.log("[BT] ServicesResolved=false (profiles closed)");
            resolve(true);
          }
        }
      });

      // Check initial state
      try {
        const current = (await props.Get("org.bluez.Device1", "ServicesResolved")).value;
        if (current === false) resolve(true);
      } catch (_) {}
    });
  }

  async disconnect() {
    if (!this.devicePath) {
      log.lib('No device path known; cannot disconnect');
      return;
    }
    log.lib("[BT] Full disconnect sequence…");

    const BLUEZ = {
      DEVICE_IFACE: "org.bluez.Device1",
      MEDIA_CONTROL_IFACE: "org.bluez.MediaControl1",
      MEDIA_PLAYER_IFACE: "org.bluez.MediaPlayer1",
      MEDIA_TRANSPORT_IFACE: "org.bluez.MediaTransport1"
    };

    // 1. Récupérer Device1
    const devObj = await this.bus.getProxyObject("org.bluez", this.devicePath);
    const device = devObj.getInterface(BLUEZ.DEVICE_IFACE);
    update.status('bluetooth.device.disconnecting', true, false);
    update.status('bluetooth.device.connecting', false, false);

    // 2. Fermer MediaPlayer1 si présent
    try {
      const props = devObj.getInterface("org.freedesktop.DBus.Properties");
      const playerPath = (await props.Get(BLUEZ.MEDIA_CONTROL_IFACE, "Player")).value;

      if (playerPath && playerPath !== "/") {
        log.lib("[BT] Releasing MediaPlayer1:", playerPath);
        const pObj = await this.bus.getProxyObject("org.bluez", playerPath);
        const player = pObj.getInterface(BLUEZ.MEDIA_PLAYER_IFACE);
        await player.Stop().catch(() => {});
      }
    } catch (_) {}

    // 3. Fermer MediaTransport1 (A2DP)
    try {
      const objects = await this.bus.call({
        destination: "org.bluez",
        path: "/",
        interface: "org.freedesktop.DBus.ObjectManager",
        member: "GetManagedObjects"
      });

      const managed = objects.body[0];

      for (const [path, ifaces] of Object.entries(managed)) {
        if (ifaces[BLUEZ.MEDIA_TRANSPORT_IFACE]) {
          if (path.includes(this.devicePath.replace("/org/bluez", ""))) {
            log.lib("[BT] Releasing A2DP transport:", path);
            const tObj = await this.bus.getProxyObject("org.bluez", path);
            const transport = tObj.getInterface(BLUEZ.MEDIA_TRANSPORT_IFACE);
            await transport.Release().catch(() => {});
          }
        }
      }
    } catch (_) {}

    // 4. Déconnecter tous les profils BlueZ
    try {
      log.lib("[BT] Disconnecting all profiles…");
      await device.DisconnectProfile("0000110e-0000-1000-8000-00805f9b34fb").catch(() => {}); // AVRCP
      await device.DisconnectProfile("0000110a-0000-1000-8000-00805f9b34fb").catch(() => {}); // A2DP Source
      await device.DisconnectProfile("0000110b-0000-1000-8000-00805f9b34fb").catch(() => {}); // A2DP Sink
      await device.DisconnectProfile("0000111f-0000-1000-8000-00805f9b34fb").catch(() => {}); // HFP AG
      await device.DisconnectProfile("0000112f-0000-1000-8000-00805f9b34fb").catch(() => {}); // PBAP
      await device.DisconnectProfile("00001132-0000-1000-8000-00805f9b34fb").catch(() => {}); // MAP
    } catch (_) {}

    // 5. Enfin : déconnexion ACL
    try {
      log.lib("[BT] Waiting for ServicesResolved=false…");
      await this.waitForServicesResolvedFalse();

      log.lib("[BT] Disconnecting ACL link…");
      await device.Disconnect();
      // Wait for Connected property to become false
      await this._waitForCondition('deviceDisconnected', () => !(status.bluetooth && status.bluetooth.device && status.bluetooth.device.connected), 10000);

      update.status('bluetooth.device.disconnecting', false, false);
      update.status('bluetooth.device.connected', false, false);

      this._updateLEDStatus();

    } catch (e) {
      log.lib("[BT] Disconnect() error:", e.message);
    }

    log.lib("[BT] Full disconnect complete.");
  }

  async play() {
    if (!this.playerPath) {
      log.lib('No player interface available; cannot Play');
      return;
    }
    try {
      // optimistic status update (update.status already logs)
      update.status('bluetooth.player.status', 'playing');

      const obj = await this.bus.getProxyObject('org.bluez', this.playerPath);
      const player = obj.getInterface('org.bluez.MediaPlayer1');
      await player.Play();
    } catch (err) {
      log.lib(`Play failed: ${err && err.message ? err.message : err}`);
    }
  }

  async pause() {
    if (!this.playerPath) {
      log.lib('No player interface available; cannot Pause');
      return;
    }
    try {
      // optimistic status update (update.status already logs)
      update.status('bluetooth.player.status', 'paused');

      const obj = await this.bus.getProxyObject('org.bluez', this.playerPath);
      const player = obj.getInterface('org.bluez.MediaPlayer1');
      await player.Pause();
    } catch (err) {
      log.lib(`Pause failed: ${err && err.message ? err.message : err}`);
    }
  }

  async next() {
    if (!this.playerPath) {
      log.lib('No player interface available; cannot Next');
      return;
    }
    try {
      const obj = await this.bus.getProxyObject('org.bluez', this.playerPath);
      const player = obj.getInterface('org.bluez.MediaPlayer1');
      await player.Next();
    } catch (err) {
      log.lib(`Next failed: ${err && err.message ? err.message : err}`);
    }
  }

  async previous() {
    if (!this.playerPath) {
      log.lib('No player interface available; cannot Previous');
      return;
    }
    try {
      const obj = await this.bus.getProxyObject('org.bluez', this.playerPath);
      const player = obj.getInterface('org.bluez.MediaPlayer1');
      await player.Previous();
    } catch (err) {
      log.lib(`Previous failed: ${err && err.message ? err.message : err}`);
    }
  }

  async toggle() {
    const statusVal = status.bluetooth && status.bluetooth.player && status.bluetooth.player.status;
    if (statusVal === 'playing') return this.pause();
    if (statusVal === 'paused') return this.play();
    return this.pause();
  }

  // -------------------------
  // Internal: subscriptions and scanning
  // -------------------------
  async _addMatch(rule) {
    const dbusObj = await this.bus.getProxyObject(
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus'
    );
    const dbus = dbusObj.getInterface('org.freedesktop.DBus');
    return dbus.AddMatch(rule);
  }

  async _subscribeObjectManager() {
    await this._addMatch("type='signal',interface='org.freedesktop.DBus.ObjectManager',member='InterfacesAdded'");
    await this._addMatch("type='signal',interface='org.freedesktop.DBus.ObjectManager',member='InterfacesRemoved'");

    this.bus.on('message', this._onInterfacesAdded);
    this.bus.on('message', this._onInterfacesRemoved);
  }

  async _subscribePropertiesChanged() {
    await this._addMatch("type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'");
    this.bus.on('message', this._onPropertiesChanged);
  }

  async _scanManagedObjects() {
    try {
      const obj = await this.bus.getProxyObject('org.bluez', '/');
      const manager = obj.getInterface('org.freedesktop.DBus.ObjectManager');
      const objects = await manager.GetManagedObjects();

      // prefer paired/trusted or phone-like devices; fallback to first Device1 found
      let fallbackDevice = null;
      for (const [path, ifaces] of Object.entries(objects)) {
        if (ifaces['org.bluez.Device1']) {
          const dev = ifaces['org.bluez.Device1'];
          const paired = dev.Paired && dev.Paired.value === true;
          const trusted = dev.Trusted && dev.Trusted.value === true;
          const name = dev.Name && dev.Name.value ? dev.Name.value : '';
          const looksLikePhone = /phone|pixel|iphone|samsung|galaxy|mobile/i.test(name);

          if (paired || trusted || looksLikePhone) {
            this._handleDeviceFound(path, dev);
            // continue scanning to pick up players/transports too
          } else {
            if (!fallbackDevice) fallbackDevice = { path, dev };
          }
        }
        if (ifaces['org.bluez.MediaPlayer1']) {
          this._handlePlayerFound(path, ifaces['org.bluez.MediaPlayer1']);
        }
        if (ifaces['org.bluez.MediaTransport1']) {
          this._handleTransportFound(path, ifaces['org.bluez.MediaTransport1']);
        }
      }

      // if no preferred device was handled, use the fallback
      if (fallbackDevice) {
        this._handleDeviceFound(fallbackDevice.path, fallbackDevice.dev);
      }
    } catch (err) {
      log.lib(`ManagedObjects scan failed: ${err && err.message ? err.message : err}`);
    }
  }

  // -------------------------
  // Signal handlers
  // -------------------------
  _onInterfacesAdded(msg) {
    if (msg.interface !== 'org.freedesktop.DBus.ObjectManager') return;
    if (msg.member !== 'InterfacesAdded') return;
    if (!msg.body || msg.body.length < 2) return;

    const path = msg.body[0];
    const interfaces = msg.body[1];

    if (interfaces['org.bluez.Device1']) {
      this._handleDeviceFound(path, interfaces['org.bluez.Device1']);
    }
    if (interfaces['org.bluez.MediaPlayer1']) {
      this._handlePlayerFound(path, interfaces['org.bluez.MediaPlayer1']);
    }
    if (interfaces['org.bluez.MediaTransport1']) {
      this._handleTransportFound(path, interfaces['org.bluez.MediaTransport1']);
    }
  }

  _onInterfacesRemoved(msg) {
    if (msg.interface !== 'org.freedesktop.DBus.ObjectManager') return;
    if (msg.member !== 'InterfacesRemoved') return;
    if (!msg.body || msg.body.length < 2) return;

    const path = msg.path;
    const interfaces = msg.body[1];

    if (interfaces.includes('org.bluez.Device1') && path === this.devicePath) {
      log.lib(`Device removed: ${path}`);
      this._clearDevice();
    }
    if (interfaces.includes('org.bluez.MediaPlayer1') && path === this.playerPath) {
      log.lib(`Player removed: ${path}`);
      this._clearPlayer();
    }
    if (interfaces.includes('org.bluez.MediaTransport1') && path === this.transportPath) {
      log.lib(`Transport removed: ${path}`);
      this._clearTransport();
    }
  }

  _onPropertiesChanged(msg) {
    if (msg.interface !== 'org.freedesktop.DBus.Properties') return;
    if (!msg.body || msg.body.length < 3) return;

    const iface = msg.body[0];
    const changed = msg.body[1];
    const path = msg.path;

    if (!path.startsWith('/org/bluez')) return;

    if (iface === 'org.bluez.Device1') {
      this._onDevicePropertiesChanged(path, changed);
    } else if (iface === 'org.bluez.MediaPlayer1') {
      this._onPlayerPropertiesChanged(path, changed);
    } else if (iface === 'org.bluez.MediaTransport1') {
      this._onTransportPropertiesChanged(path, changed);
    }
  }

  // -------------------------
  // Object found handlers
  // -------------------------
  _handleDeviceFound(path, props) {
    if (this.devicePath && this.devicePath === path) {
      this.deviceProps = { ...this.deviceProps, ...props };
      return;
    }

    const name = props.Name ? props.Name.value : null;

    if (!this.devicePath) {
      this.devicePath = path;
      this.deviceProps = props;
      status.bluetooth = status.bluetooth || {};
      status.bluetooth.interfaces = status.bluetooth.interfaces || {};
      status.bluetooth.interfaces.device = path;
      status.bluetooth.device = status.bluetooth.device || {};
      status.bluetooth.device.name = name || status.bluetooth.device.name || null;
      status.bluetooth.device.connected = !!(props.Connected && props.Connected.value);

      update.status('bluetooth.interfaces.device', path);
      update.status('bluetooth.device.name', name || null);
      update.status('bluetooth.device.connected', status.bluetooth.device.connected);

      if (status.bluetooth.device.connected === true) {
        update.status('bluetooth.device.connecting', false);
        update.status('bluetooth.device.disconnecting', false);
        update.status('bluetooth.device.connected', true);
      } else {
        update.status('bluetooth.device.connecting', false);
        update.status('bluetooth.device.disconnecting', false);
        update.status('bluetooth.device.connected', false);
      }

      this._updateLEDStatus();
      this._resolveWaiter('deviceFound');
    }
  }

  _handlePlayerFound(path, props) {
    this.playerPath = path;
    this.playerProps = props;

    status.bluetooth = status.bluetooth || {};
    status.bluetooth.interfaces = status.bluetooth.interfaces || {};
    status.bluetooth.interfaces.player = path;
    status.bluetooth.player = status.bluetooth.player || {};
    status.bluetooth.player.status = props.Status ? props.Status.value : status.bluetooth.player.status || null;

    update.status('bluetooth.interfaces.player', path);
    update.status('bluetooth.player.status', status.bluetooth.player.status || null);

    log.lib(`Player discovered at ${path}`);
    this._resolveWaiter('playerFound');
  }

  _handleTransportFound(path, props) {
    this.transportPath = path;
    this.transportProps = props;

    status.bluetooth = status.bluetooth || {};
    status.bluetooth.interfaces = status.bluetooth.interfaces || {};
    status.bluetooth.interfaces.transport = path;

    update.status('bluetooth.interfaces.transport', path);

    log.lib(`Transport discovered at ${path}`);
    this._resolveWaiter('transportFound');
  }

  // -------------------------
  // Properties changed handlers
  // -------------------------
  _onDevicePropertiesChanged(path, changed) {
    if (path !== this.devicePath) {
/*      if (!this.devicePath) {
        if (changed.Name || changed.UUIDs) {
          this._handleDeviceFound(path, changed);
        }
      }*/
      return;
    }

    for (const [k, v] of Object.entries(changed)) {
      log.lib(`Deviceprop   ${k}: ${v}`);
      this.deviceProps[k] = v;
    }

    if (changed.Connected !== undefined) {
      const connected = changed.Connected.value === true;
      log.lib(`Device isConnected: ${connected}`);
      status.bluetooth = status.bluetooth || {};
      status.bluetooth.device = status.bluetooth.device || {};
      status.bluetooth.device.connected = connected;

      update.status('bluetooth.device.connected', connected, false);

      if (connected) {
        update.status('bluetooth.device.connecting', false, false);
        update.status('bluetooth.device.disconnecting', false, false);
        update.status('bluetooth.device.connected', true, false);
      } else {
        update.status('bluetooth.device.disconnecting', false, false);
        update.status('bluetooth.device.connecting', false, false);
        update.status('bluetooth.device.connected', false, false);
      }

      this._updateLEDStatus();
      this._resolveWaiter('deviceConnected');
      this._resolveWaiter('deviceDisconnected');
    }

    if (changed.Name !== undefined) {
      const name = changed.Name.value;
      status.bluetooth.device.name = name;
      update.status('bluetooth.device.name', name, true);
    }

    if (changed.ServicesResolved !== undefined) {
      log.lib(`ServicesResolved.value = ${changed.servicesResolved}`);
      const resolved = changed.ServicesResolved.value === true;
      update.status('bluetooth.device.servicesResolved', resolved);
      log.lib(`ServicesResolved = ${resolved} for ${this.devicePath}`);
      if (resolved) {
        this.forceAvrcpAndA2dp();
      }
    }
  }

  _onPlayerPropertiesChanged(path, changed) {
    if (!this.playerPath) {
      this._handlePlayerFound(path, changed);
    }
    if (path !== this.playerPath) return;

    // Convert changed map to plain object of values
    const changedPlain = {};
    for (const [k, v] of Object.entries(changed)) {
      changedPlain[k] = v;
    }

    // If Status changed, update player status (update.status already logs)
    if (changedPlain.Status !== undefined) {
      const statusVal = changedPlain.Status.value;
      status.bluetooth = status.bluetooth || {};
      status.bluetooth.player = status.bluetooth.player || {};
      status.bluetooth.player.status = statusVal;
      update.status('bluetooth.player.status', statusVal);
      // LED update depends on player status
      this._updateLEDStatus();
      // Do not duplicate log here because update.status logs status changes
    }

    // Call the rewritten interfacePropertiesPlayerChanged logic for other metadata
    this._interfacePropertiesPlayerChanged('org.bluez.MediaPlayer1', [Object.entries(changedPlain)]);

    // Update cached player props
    for (const [k, v] of Object.entries(changed)) {
      this.playerProps[k] = v;
    }
  }

  _onTransportPropertiesChanged(path, changed) {
    if (!this.transportPath) {
      this._handleTransportFound(path, changed);
    }
    if (path !== this.transportPath) return;

    for (const [k, v] of Object.entries(changed)) {
      this.transportProps[k] = v;
    }

    if (changed.State !== undefined) {
      const state = changed.State.value;
      update.status('bluetooth.transport.state', state);
      log.lib(`Transport state changed to ${state}`);
    }
  }

  // -------------------------
  // Rewritten interfacePropertiesPlayerChanged logic
  // -------------------------
  _interfacePropertiesPlayerChanged(service, data1) {
    if (!data1 || !data1[0]) return;
    if (!data1[0][0]) return;

    const propertyKey = String(data1[0][0][0]).toLowerCase();
    const serviceFmt = service.replace('org.bluez.', '');

    // Avoid duplicate logging for 'status' because update.status already logs it
    if (propertyKey !== 'position' && propertyKey !== 'status') {
      log.lib(`Player '${status.bluetooth.interfaces.player}' service '${serviceFmt}' property '${propertyKey}' changed`);
    }

    if (!data1[0][1]) return;
    if (!data1[0][1][1]) return;

    const value = data1[0][1][1][0];

    switch (typeof value) {
      case 'boolean':
      case 'number':
      case 'object':
      case 'string':
        break;
      default:
        return;
    }

    if (typeof status.bluetooth.services === 'undefined') status.bluetooth.services = {};
    if (typeof status.bluetooth.services.player === 'undefined') status.bluetooth.services.player = {};
    if (typeof status.bluetooth.services.player[serviceFmt] === 'undefined') status.bluetooth.services.player[serviceFmt] = {};

    update.status(`bluetooth.services.player.${serviceFmt}.${propertyKey}`, value);

    // Update player-level property and check if changed
    const changed = update.status(`bluetooth.player.${propertyKey}`, value, false);
    if (!changed) return;

    // If the value is an object (e.g., Track metadata), parse it
    if (typeof data1[0][1][1][0] === 'object') {
      if (Array.isArray(data1[0][1][1][0])) {
        for (const key of data1[0][1][1][0]) {
          if (typeof key[1] === 'undefined') continue;
          if (typeof key[1][1] === 'undefined') continue;
          if (typeof key[1][1][0] === 'undefined') continue;

          const kName = String(key[0]).toLowerCase();
          const kValue = key[1][1][0];

          update.status(`bluetooth.player.${kName}`, kValue, false);
        }
      } else {
        const obj = data1[0][1][1][0];
        if (obj['Title'] || obj['title']) {
          const title = obj['Title'] ? obj['Title'] : obj['title'];
          update.status('bluetooth.player.title', title, false);
        }
        if (obj['Artist'] || obj['artist']) {
          const artist = obj['Artist'] ? obj['Artist'] : obj['artist'];
          update.status('bluetooth.player.artist', artist, false);
        }
        if (obj['Album'] || obj['album']) {
          const album = obj['Album'] ? obj['Album'] : obj['album'];
          update.status('bluetooth.player.album', album, false);
        }
      }
    }

    // Update MID text if configured
    if (config && config.media && config.media.bluetooth && config.media.bluetooth.text && config.media.bluetooth.text.mid === true) {
      const artist = status.bluetooth.player && status.bluetooth.player.artist ? status.bluetooth.player.artist : '';
      const title = status.bluetooth.player && status.bluetooth.player.title ? status.bluetooth.player.title : '';
      if (update.status('mid.text.right', `${artist} - ${title}`)) {
        if (MID && typeof MID.refresh_text === 'function') MID.refresh_text();
      }
    }

    // Update IKE text if configured
    if (!(config && config.media && config.media.bluetooth && config.media.bluetooth.text && config.media.bluetooth.text.ike === true)) return;

    if (!status.bluetooth.player || !status.bluetooth.player.artist || !status.bluetooth.player.title) return;

    const strings = {
      artist: String(status.bluetooth.player.artist).replace(/feat/gi, 'feat'),
      title: String(status.bluetooth.player.title).replace(/feat/gi, 'feat'),
    };

    strings.artist = strings.artist.split(' (feat. ')[0];
    strings.title = strings.title.split(' (feat. ')[0];
    strings.artist = strings.artist.split(' [feat. ')[0];
    strings.title = strings.title.split(' [feat. ')[0];
    strings.artist = strings.artist.split(' feat. ')[0];
    strings.title = strings.title.split(' feat. ')[0];

    if (IKE && typeof IKE.text_override === 'function') {
      IKE.text_override(`${strings.artist} - ${strings.title}`);
    }
  }

  // -------------------------
  // Helpers
  // -------------------------
  _clearDevice() {
    this.devicePath = null;
    this.deviceProps = {};
    if (status && status.bluetooth && status.bluetooth.interfaces) {
      status.bluetooth.interfaces.device = null;
      update.status('bluetooth.interfaces.device', null);
    }
    this._updateLEDStatus();
  }

  _clearPlayer() {
    this.playerPath = null;
    this.playerProps = {};
    if (status && status.bluetooth && status.bluetooth.interfaces) {
      status.bluetooth.interfaces.player = null;
      update.status('bluetooth.interfaces.player', null);
    }
  }

  _clearTransport() {
    this.transportPath = null;
    this.transportProps = {};
    if (status && status.bluetooth && status.bluetooth.interfaces) {
      status.bluetooth.interfaces.transport = null;
      update.status('bluetooth.interfaces.transport', null);
    }
  }

  _updateLEDStatus() {
    const connected = !!(status.bluetooth && status.bluetooth.device && status.bluetooth.device.connected);
    const playerStatus = status.bluetooth && status.bluetooth.player && status.bluetooth.player.status;

    update.status('led.solid_red', !connected);
    update.status('led.solid_yellow', playerStatus === 'paused');
    update.status('led.solid_green', connected);

    if (TEL && typeof TEL.setLEDs === 'function') {
      try {
        TEL.setLEDs();
      } catch (e) {
        log.lib(`TEL.setLEDs error: ${e && e.message ? e.message : e}`);
      }
    }
  }

  _resolveWaiter(name) {
    const w = this.waiters.get(name);
    if (w && typeof w.resolve === 'function') {
      w.resolve();
      this.waiters.delete(name);
    }
  }

  _waitForCondition(name, conditionFn, timeout = 8000) {
    try {
      if (conditionFn()) return Promise.resolve();
    } catch (e) {
      // ignore
    }

    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        try {
          if (conditionFn()) {
            clearInterval(interval);
            resolve();
            return;
          }
        } catch (e) {
          // ignore
        }
        if (Date.now() - start > timeout) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for ${name}`));
        }
      }, 150);

      this.waiters.set(name, {
        resolve: () => {
          clearInterval(interval);
          resolve();
        },
        reject: () => {
          clearInterval(interval);
          reject(new Error(`Waiter ${name} rejected`));
        },
      });
    });
  }

  async _populateInitialProperties() {
    try {
      // Device
      if (this.devicePath) {
        const devObj = await this.bus.getProxyObject('org.bluez', this.devicePath);
        const propsIface = devObj.getInterface('org.freedesktop.DBus.Properties');
        const devProps = await propsIface.GetAll('org.bluez.Device1');
        // Convert Variants to plain values and feed handler
        const devChanged = {};
        for (const [k, v] of Object.entries(devProps)) devChanged[k] = v;
        this._onDevicePropertiesChanged(this.devicePath, devChanged);
      }

      // Player
      if (this.playerPath) {
        const playerObj = await this.bus.getProxyObject('org.bluez', this.playerPath);
        const propsIface = playerObj.getInterface('org.freedesktop.DBus.Properties');
        const playerProps = await propsIface.GetAll('org.bluez.MediaPlayer1');
        const playerChanged = {};
        for (const [k, v] of Object.entries(playerProps)) playerChanged[k] = v;
        // Ensure status is updated and metadata parsed
        if (playerChanged.Status !== undefined) {
          const statusVal = playerChanged.Status.value;
          status.bluetooth = status.bluetooth || {};
          status.bluetooth.player = status.bluetooth.player || {};
          status.bluetooth.player.status = statusVal;
          update.status('bluetooth.player.status', statusVal);
        }
        this._interfacePropertiesPlayerChanged('org.bluez.MediaPlayer1', [Object.entries(playerChanged)]);
      }

      // Transport
      if (this.transportPath) {
        const transObj = await this.bus.getProxyObject('org.bluez', this.transportPath);
        const propsIface = transObj.getInterface('org.freedesktop.DBus.Properties');
        const transProps = await propsIface.GetAll('org.bluez.MediaTransport1');
        const transChanged = {};
        for (const [k, v] of Object.entries(transProps)) transChanged[k] = v;
        this._onTransportPropertiesChanged(this.transportPath, transChanged);
      }
    } catch (e) {
      log.lib(`Initial properties fetch failed: ${e && e.message ? e.message : e}`);
    }
  }

async connectToFirstPairedDevice() {
    try {
      if (!this.bus) this.bus = (typeof bus !== 'undefined' ? bus : (typeof systemBus !== 'undefined' ? systemBus() : require('dbus-next').systemBus()));

      const rootObj = await this.bus.getProxyObject('org.bluez', '/');
      const om = rootObj.getInterface('org.freedesktop.DBus.ObjectManager');
      const managed = await om.GetManagedObjects();

      let fallback = null;
      let chosenPath = null;

      for (const [path, ifaces] of Object.entries(managed)) {
        log.lib('connectToFirstPairedDevice: path: ', path);
        const devIface = ifaces['org.bluez.Device1'];
        if (!devIface) continue;
        if (path === '/org/bluez/hci0') continue;

        const paired = !!(devIface.Paired && devIface.Paired.value === true);
        const trusted = !!(devIface.Trusted && devIface.Trusted.value === true);
        const name = devIface.Name && devIface.Name.value ? devIface.Name.value : '';
        const looksLikePhone = /phone|pixel|iphone|samsung|galaxy|mobile/i.test(name);

        if (paired || trusted || looksLikePhone) {
          chosenPath = path;
          break;
        }
        if (!fallback) fallback = path;
      }

      if (!chosenPath && fallback) chosenPath = fallback;
      if (!chosenPath) {
        log.lib('connectToFirstPairedDevice: no Device1 objects found');
        return false;
      }

      this.devicePath = chosenPath;
      log.lib(`connectToFirstPairedDevice: selected ${this.devicePath}`);

      const devObj = await this.bus.getProxyObject('org.bluez', this.devicePath);
      const devProps = devObj.getInterface('org.freedesktop.DBus.Properties');
      const connectedProp = await devProps.Get('org.bluez.Device1', 'Connected');
      const isConnected = !!(connectedProp && connectedProp.value === true);

      if (isConnected) {
        log.lib(`Device already connected: ${this.devicePath}`);
        return true;
      }

      const devIface = devObj.getInterface('org.bluez.Device1');
      try {
        await devIface.Connect();
        log.lib(`Connect() invoked for ${this.devicePath}`);
      } catch (err) {
        log.lib(`Connect() error for ${this.devicePath}: ${err && err.message ? err.message : err}`);
        return false;
      }

      // wait briefly and verify
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 500));
        const check = await devProps.Get('org.bluez.Device1', 'Connected');
        if (check && check.value === true) {
          log.lib(`Device connected: ${this.devicePath}`);
          return true;
        }
      }

      log.lib(`Device did not become connected after Connect(): ${this.devicePath}`);
      return false;
    } catch (err) {
      log.lib(`connectToFirstPairedDevice error: ${err && err.message ? err.message : err}`);
      return false;
    }
  }
}

let controller = null;

// -------------------------
// Global init helper
// -------------------------
async function init() {
  // Bounce if bluetooth disabled or wrong platform
  if (config.media.bluetooth.enable === false || os.platform() !== 'linux') return false;

  if (typeof log === 'undefined' || typeof update === 'undefined' || typeof status === 'undefined') {
    throw new Error('Required globals missing: log, update, status');
  }

  log.lib('Initializing');

  status.bluetooth = status.bluetooth || {};
  status.bluetooth.interfaces = status.bluetooth.interfaces || {};
  status.bluetooth.device = status.bluetooth.device || {};
  status.bluetooth.player = status.bluetooth.player || {};

  controller = new BluetoothController();
  await controller.init();

  status.bluetoothController = controller;

  return controller;
}


// Read dbus and get 1st paired device's name, status, path, etc
async function init_listeners() {
	// Bounce if bluetooth is disabled, bluetooth event listeners have already been set up, or wrong platform
	if (config.media.bluetooth.enable === false || os.platform() !== 'linux') return false;

	await controller.connect();
//        await controller.forceAvrcpAndA2dp();
	// Connect/disconnect bluetooth device on power module event
	power.on('active', async (power_state) => {
		log.lib(`Received power.onActive state ${power_state}`);
		await new Promise(resolve => setTimeout(resolve, 1000));

		switch (power_state) {
			case false : {
				if (status.bluetooth.player.status === 'playing') {
					await controller.pause();
				}

				await new Promise(resolve => setTimeout(resolve, 1000));
				await controller.disconnect();
				await new Promise(resolve => setTimeout(resolve, 1000));

				log.lib(`Device number is currently ${bluetooth.deviceNumber}, resetting device number to ${bluetooth.deviceNumberDefault}`);
				bluetooth.deviceNumber = bluetooth.deviceNumberDefault;
				break;
			}

			case true : {
				await controller.connect();
			}
		}
	});



	log.lib('Initialized listeners');
} // async init_listeners()


module.exports = {
	dbus       : null,
	service    : null,
	systemDbus : null,

	deviceNumber        : 2,
	deviceNumberDefault : 2,

	listenersActive : false,

	propertiesChangedListenersSet : {
		adapter : false,
		device  : false,
		player  : false,
	},

	dbusInterfaces : {
		root    : null,
		adapter : null,
		device  : null,
		player  : null,
	},

	// BlueZ 5 dbus paths
	paths : {
		bluez : {
			main  : 'org.bluez',
			media : 'org.bluez.MediaPlayer1',
		},
		dbus : {
			objMan : 'org.freedesktop.DBus.ObjectManager',
			prop   : 'org.freedesktop.DBus.Properties',
		},
	},


    // Functions
    connect : () => controller.connect(),
    disconnect : () => controller.disconnect(),
    play : () => controller.play(),
    pause : () => controller.pause(),
    next : () => controller.next(),
    previous : () => controller.previous(),
    toggle : () => controller.toggle(),

    init,
    init_listeners,
};
