const { spawn } = require("child_process");
const WS = require("websocket").w3cwebsocket;
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const constants = require("./constants.js")
const path = require("path");

let retryHandler = null;
let authInfo = null;
let ws = null;
const nativeCalls = {};
const offlineMessageQueue = [];

const startWebsocket = () => {
  authInfo = getAuthInfo();

  if (!authInfo) {
    retryLater();
    return;
  }
  ws =
    new WS(`ws://127.0.0.1:${authInfo.nlPort}?extensionId=js.neutralino.devtools
                  &connectToken=${authInfo.nlConnectToken}`);

  ws.onerror = () => {
    retryLater();
  };

  ws.onopen = () => {
    console.log("Connected with the application.");
  };

  ws.onclose = () => {
    console.log("Connection closed.");
  };

  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const message = JSON.parse(e.data);
      console.log("Received message: ", message);

      if (message.id && message.id in nativeCalls) {
        // Native call response
        if (message.data?.error) {
          nativeCalls[message.id].reject(message.data.error);
          if (message.data.error.code == 'NE_RT_INVTOKN') {
            // Invalid native method token
            handleNativeMethodTokenError();
          }
        }
        else if (message.data?.success) {
          nativeCalls[message.id]
            .resolve(message.data.hasOwnProperty('returnValue') ? message.data.returnValue
              : message.data);
        }
        delete nativeCalls[message.id];
      }
    }
  }
};

const stopWebsocket = () => {
  if (retryHandler) {
    clearTimeout(retryHandler);
  }
  if (ws) {
    ws.close();
    if (fs.existsSync(constants.files.authFile)) {
      fs.unlinkSync(constants.files.authFile);
    }
  }
};

const sendMessage = (method, data) => {
  return new Promise((resolve, reject) => {
    // if (ws?.readyState != WebSocket.OPEN) {
    if (ws?.readyState != 1) {
      offlineMessageQueue.push({ method, data, resolve, reject });
      return;
    }

    const id = uuidv4();

    nativeCalls[id] = { resolve, reject };

    if (!authInfo) {
      console.error("Auth info is not available.");
      return;
    }

    ws.send(
      JSON.stringify({
        id,
        method,
        data,
        accessToken: authInfo.nlToken,
      })
    );
  });
};

function getAuthInfo() {
  let authInfo = null;
  try {
    authInfo = fs.readFileSync(constants.files.authFile, "utf8");
    authInfo = JSON.parse(authInfo);
  } catch (err) {
    // ignore
  }
  return authInfo;
}

function retryLater() {
  reconnecting = true;
  retryHandler = setTimeout(() => {
    reconnecting = false;
    startWebsocket();
  }, 1000);
}

function normalize(arg) {
  if (typeof arg != "string") return arg;
  arg = arg.trim();
  if (arg.includes(" ")) {
    arg = `"${arg}"`;
  }
  return arg;
}

function getBinaryName(arch) {
  let platform = process.platform;

  if (!(platform in constants.files.binaries)) return "";
  if (!(arch in constants.files.binaries[process.platform])) return "";
  return constants.files.binaries[process.platform][arch];
}

function base64ToBytesArray(data) {
  const binaryData = window.atob(data);
  const len = binaryData.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binaryData.charCodeAt(i);
  }

  return bytes.buffer;
}

function arrayBufferToBase64(data) {
  let bytes = new Uint8Array(data);
  let asciiStr = "";

  for (let byte of bytes) {
    asciiStr += String.fromCharCode(byte);
  }

  return window.btoa(asciiStr);
}

class NeutralinoApp {
  url = "";
  windowOptions = {};

  constructor({ url, windowOptions }) {
    this.url = url;
    this.windowOptions = windowOptions;
  }

  init() {
    startWebsocket();

    const EXEC_PERMISSION = 0o755;

    let outputArgs = " --url=" + normalize(this.url);

    for (let key in this.windowOptions) {
      if (key == "processArgs") continue;

      let cliKey = key.replace(
        /[A-Z]|^[a-z]/g,
        (token) => "-" + token.toLowerCase()
      );
      outputArgs += ` --window${cliKey}=${this.windowOptions[key]}`;
    }

    if (this.windowOptions && this.windowOptions.processArgs) {
      outputArgs += " " + this.windowOptions.processArgs;
    }

    let arch = process.arch;

    let binaryName = getBinaryName(arch);

    if (!binaryName) {
      return console.error(
        `Unsupported platform or CPU architecture: ${process.platform}_${arch}`
      );
    }

    let binaryPath = `bin${path.sep}${binaryName}`;
    let args =
      " --load-dir-res --path=. --export-auth-info --neu-dev-extension";
    if (outputArgs) args += " " + outputArgs;

    if (process.platform == "linux" || process.platform == "darwin")
      fs.chmodSync(binaryPath, EXEC_PERMISSION);

    console.log(`Starting process: ${binaryName} ${args}`);

    const neuProcess = spawn(binaryPath, args.split(` `), { stdio: "inherit" });

    neuProcess.on("exit", function (code) {
      let statusCodeMsg = code ? `error code ${code}` : `success code 0`;
      let runnerMsg = `${binaryName} was stopped with ${statusCodeMsg}`;
      if (code) {
        console.warn(runnerMsg);
      } else {
        console.warn(runnerMsg);
      }

      stopWebsocket();

      if (this.windowOptions && this.windowOptions.exitProcessOnClose) {
        process.exit(code);
      }
    });
  }

  exit(code) {
    return sendMessage("app.exit", { code });
  }
  killProcess() {
    return sendMessage("app.killProcess");
  }
  getConfig() {
    return sendMessage("app.getConfig");
  }

  broadcast(event, data) {
    return sendMessage("app.broadcast", { event, data });
  }

  readProcessInput(readAll) {
    return sendMessage("app.readProcessInput", { readAll });
  }

  writeProcessOutput(data) {
    return sendMessage("app.writeProcessOutput", { data });
  }

  writeProcessError(data) {
    return sendMessage("app.writeProcessError", { data });
  }

  clipboard = {
    getFormat() {
      return sendMessage("clipboard.getFormat");
    },

    readText() {
      return sendMessage("clipboard.readText");
    },

    readImage() {
      return new Promise((resolve, reject) => {
        sendMessage("clipboard.readImage")
          .then((image) => {
            if (image) {
              image.data = base64ToBytesArray(image.data);
            }
            resolve(image);
          })
          .catch((error) => {
            reject(error);
          });
      });
    },

    writeText(data) {
      return sendMessage("clipboard.writeText", { data });
    },

    writeImage(image) {
      const props = { ...image };
      if (image?.data) {
        props.data = arrayBufferToBase64(image.data);
      }
      return sendMessage("clipboard.writeImage", props);
    },

    clear() {
      return sendMessage("clipboard.clear");
    },
  };

  computer = {
    getMemoryInfo() {
      return sendMessage("computer.getMemoryInfo");
    },
    getArch() {
      return sendMessage("computer.getArch");
    },
    getKernelInfo() {
      return sendMessage("computer.getKernelInfo");
    },
    getOSInfo() {
      return sendMessage("computer.getOSInfo");
    },
    getCPUInfo() {
      return sendMessage("computer.getCPUInfo");
    },
    getDisplays() {
      return sendMessage("computer.getDisplays");
    },
    getMousePosition() {
      return sendMessage("computer.getMousePosition");
    },
  };

  custom = {
    getMethods() {
      return sendMessage('custom.getMethods');
    }
  }

  debug = {
    log(message, type) {
      return sendMessage('debug.log', { message, type });
    }
  }

  events = {
    broadcast(event, data) {
      return sendMessage('events.broadcast', { event, data });
    }
  };

  extensions = {
    broadcast(event, data) {
      return sendMessage('extensions.broadcast', { event, data });
    },
    getStats() {
      return sendMessage('extensions.getStats');
    }
  };

  filesystem = {
    createDirectory(path) {
      return sendMessage('filesystem.createDirectory', { path });
    },

    remove(path) {
      return sendMessage('filesystem.remove', { path });
    },

    writeFile(path, data) {
      return sendMessage('filesystem.writeFile', { path, data });
    },

    appendFile(path, data) {
      return sendMessage('filesystem.appendFile', { path, data });
    },

    writeBinaryFile(path, data) {
      return sendMessage('filesystem.writeBinaryFile', {
        path,
        data: arrayBufferToBase64(data)
      });
    },

    appendBinaryFile(path, data) {
      return sendMessage('filesystem.appendBinaryFile', {
        path,
        data: arrayBufferToBase64(data)
      });
    },

    readFile(path, options) {
      return sendMessage('filesystem.readFile', { path, ...options });
    },

    readBinaryFile(path, options) {
      return new Promise((resolve, reject) => {
        sendMessage('filesystem.readBinaryFile', { path, ...options })
          .then((base64Data) => {
            resolve(base64ToBytesArray(base64Data));
          })
          .catch((error) => {
            reject(error);
          });
      });
    },

    openFile(path) {
      return sendMessage('filesystem.openFile', { path });
    },

    createWatcher(path) {
      return sendMessage('filesystem.createWatcher', { path });
    },

    removeWatcher(id) {
      return sendMessage('filesystem.removeWatcher', { id });
    },

    getWatchers() {
      return sendMessage('filesystem.getWatchers');
    },

    updateOpenedFile(id, event, data) {
      return sendMessage('filesystem.updateOpenedFile', { id, event, data });
    },

    getOpenedFileInfo(id) {
      return sendMessage('filesystem.getOpenedFileInfo', { id });
    },

    readDirectory(path, options) {
      return sendMessage('filesystem.readDirectory', { path, ...options });
    },

    copy(source, destination) {
      return sendMessage('filesystem.copy', { source, destination });
    },

    move(source, destination) {
      return sendMessage('filesystem.move', { source, destination });
    },

    getStats(path) {
      return sendMessage('filesystem.getStats', { path });
    }
  };

  storage = {
    setData(key, data) {
      return sendMessage('storage.setData', { key, data });
    },

    getData(key) {
      return sendMessage('storage.getData', { key });
    },

    getKeys() {
      return sendMessage('storage.getKeys');
    }
  };

  os = {
    execCommand(command, options) {
      return sendMessage('os.execCommand', { command, ...options });
    },

    spawnProcess(command, cwd) {
      return sendMessage('os.spawnProcess', { command, cwd });
    },

    updateSpawnedProcess(id, event, data) {
      return sendMessage('os.updateSpawnedProcess', { id, event, data });
    },

    getSpawnedProcesses() {
      return sendMessage('os.getSpawnedProcesses');
    },

    getEnv(key) {
      return sendMessage('os.getEnv', { key });
    },

    getEnvs() {
      return sendMessage('os.getEnvs');
    },

    showOpenDialog(title, options) {
      return sendMessage('os.showOpenDialog', { title, ...options });
    },

    showFolderDialog(title, options) {
      return sendMessage('os.showFolderDialog', { title, ...options });
    },

    showSaveDialog(title, options) {
      return sendMessage('os.showSaveDialog', { title, ...options });
    },

    showNotification(title, content, icon) {
      return sendMessage('os.showNotification', { title, content, icon });
    },

    showMessageBox(title, content, choice, icon) {
      return sendMessage('os.showMessageBox', { title, content, choice, icon });
    },

    setTray(options) {
      return sendMessage('os.setTray', options);
    },

    open(url) {
      return sendMessage('os.open', { url });
    },

    getPath(name) {
      return sendMessage('os.getPath', { name });
    },

  }

  window = {
    setTitle(title) {
      return sendMessage('window.setTitle', { title });
    },

    getTitle() {
      return sendMessage('window.getTitle');
    },

    maximize() {
      return sendMessage('window.maximize');
    },

    unmaximize() {
      return sendMessage('window.unmaximize');
    },

    isMaximized() {
      return sendMessage('window.isMaximized');
    },

    minimize() {
      return sendMessage('window.minimize');
    },

    setFullScreen() {
      return sendMessage('window.setFullScreen');
    },

    exitFullScreen() {
      return sendMessage('window.exitFullScreen');
    },

    isFullScreen() {
      return sendMessage('window.isFullScreen');
    },

    show() {
      return sendMessage('window.show');
    },

    hide() {
      return sendMessage('window.hide');
    },

    isVisible() {
      return sendMessage('window.isVisible');
    },

    focus() {
      return sendMessage('window.focus');
    },

    setIcon(icon) {
      return sendMessage('window.setIcon', { icon });
    },

    move(x, y) {
      return sendMessage('window.move', { x, y });
    },

    center() {
      return sendMessage('window.center');
    },

    setSize(options) {
      return new Promise(async (resolve, reject) => {
        let sizeOptions = await getSize();

        options = { ...sizeOptions, ...options }; // merge prioritizing options arg

        sendMessage('window.setSize', options)
          .then((response) => {
            resolve(response);
          })
          .catch((error) => {
            reject(error);
          });
      });
    },

    getSize() {
      return sendMessage('window.getSize');
    },

    getPosition() {
      return sendMessage('window.getPosition');
    },

    setAlwaysOnTop(onTop) {
      return sendMessage('window.setAlwaysOnTop', { onTop });
    },

    create: async (url, options) => {
      return new Promise((resolve, reject) => {

        options = { ...options, useSavedState: false };
        // useSavedState: false -> Child windows won't save their states

        function normalize(arg) {
          if (typeof arg != "string")
            return arg;
          arg = arg.trim();
          if (arg.includes(" ")) {
            arg = `"${arg}"`;
          }
          return arg;
        }

        let command = " --url=" + normalize(url);

        for (let key in options) {
          if (key == "processArgs")
            continue;

          let cliKey = key.replace(/[A-Z]|^[a-z]/g, (token) => (
            "-" + token.toLowerCase()
          ));
          command += ` --window${cliKey}=${normalize(options[key])}`
        }

        if (options && options.processArgs)
          command += " " + options.processArgs;

        this.os.execCommand(command, { background: true })
          .then((processInfo) => {
            resolve(processInfo);
          })
          .catch((error) => {
            reject(error);
          });
      })
    }
  };
}

module.exports = NeutralinoApp 
