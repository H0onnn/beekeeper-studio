'use strict'
import * as fs from 'fs'
import { app, protocol, dialog } from 'electron'
import log from 'electron-log'
import * as electron from 'electron'
import { ipcMain } from 'electron'
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer'

// eslint-disable-next-line
require('@electron/remote/main').initialize()
log.transports.file.level = "info"
log.catchErrors({ showDialog: false})
log.info("initializing background")

import { manageUpdates } from './background/update_manager'

import MenuHandler from './background/NativeMenuBuilder'
import { IGroupedUserSettings, UserSetting } from './common/appdb/models/user_setting'
import Connection from './common/appdb/Connection'
import Migration from './migration/index'
import { buildWindow, getActiveWindows } from './background/WindowBuilder'
import platformInfo from './common/platform_info'

import { AppEvent } from './common/AppEvent'

function initUserDirectory(d: string) {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true })
  }
}

const transports = [log.transports.console, log.transports.file]
if (platformInfo.isDevelopment || platformInfo.debugEnabled) {
  transports.forEach(t => t.level = 'silly')
} else {
  transports.forEach(t => t.level = 'warn')
}

const isDevelopment = platformInfo.isDevelopment


initUserDirectory(platformInfo.userDirectory)
log.info("initializing user ORM connection")
const ormConnection = new Connection(platformInfo.appDbPath, false)
log.debug("ELECTRON BOOTING")
log.debug("####################################")

log.debug("Platform Information (Electron)")
log.debug(JSON.stringify(platformInfo, null, 2))
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let settings: IGroupedUserSettings
let menuHandler
log.debug("registering schema")
// Scheme must be registered before the app is ready
protocol.registerSchemesAsPrivileged([{scheme: 'app', privileges: { secure: true, standard: true } }])
let initialized = false

async function initBasics() {
  if (initialized) return settings
  initialized = true
  await ormConnection.connect()
  console.log("LD_LIBRARY_PATH", process.env.LD_LIBRARY_PATH)
  log.info("running migrations")
  const migrator = new Migration(ormConnection, process.env.NODE_ENV)
  await migrator.run()


  log.debug("getting settings")
  settings = await UserSetting.all()

  if (settings.oracleInstantClient) {
    process.env['LD_LIBRARY_PATH'] = `${process.env.LD_LIBRARY_PATH}:${settings.oracleInstantClient.value}`
  }

  log.debug("setting up the menu")
  menuHandler = new MenuHandler(electron, settings)
  menuHandler.initialize()
  log.debug("Building the window")
  log.debug("managing updates")
  manageUpdates()
  ipcMain.on(AppEvent.openExternally, (_e: electron.IpcMainEvent, args: any[]) => {
    const url = args[0]
    if (!url) return
    electron.shell.openExternal(url)
  })
  return settings
}

// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async (_event, hasVisibleWindows) => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (!hasVisibleWindows) {
    if (!settings) throw "No settings initialized!"
    buildWindow(settings)
  }
})

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (isDevelopment && !process.env.IS_TEST) {
    // Need to explicitly disable CORS when running in dev mode because
    // we can't connect to bigquery-emulator on localhost.
    // See: https://github.com/electron/electron/issues/23664
    console.log("Dev mode detected, disabling CORS")
    app.commandLine.appendSwitch('disable-web-security');
    app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')
    // Install Vue Devtools
    try {
      console.log("installing vue devtools")
      await installExtension(VUEJS_DEVTOOLS)
    } catch (e) {
      console.error('Vue Devtools failed to install:', e.toString())
    }
  }

  // this gets positional arguments
  const options = platformInfo.parsedArgs._.map((url: string) => ({ url }))
  const settings = await initBasics()

  if (options.length > 0) {

    await Promise.all(options.map((option) => buildWindow(settings, option)))
  } else {
    if (getActiveWindows().length === 0) {
      const settings = await initBasics()
      await buildWindow(settings)
    }
  }
})

// Show exit confirmation modal before quitting
app.on("before-quit", (event) => {
  const choice = dialog.showMessageBoxSync(null, {
    type: "question",
    buttons: ["Exit", "Cancel"],
    message: "Really close application?\nYou lose all unsaved changes",
  });

  if (choice === 0) {
    app.exit();
  } else {
    event.preventDefault();
  }
});

// Open a connection from a file (e.g. ./sqlite.db)
app.on('open-file', async (event, file) => {
  event.preventDefault();
  const settings = await initBasics()
  await buildWindow(settings, { url: file })
});

// Open a connection from a url (e.g. postgres://host)
app.on('open-url', async (event, url) => {
  event.preventDefault();
  const settings = await initBasics()

  await buildWindow(settings, { url })
});

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
  if (process.platform === 'win32') {
    process.on('message', data => {
      if (data === 'graceful-exit') {
        app.quit()
      }
    })
  } else {
    process.on('SIGTERM', () => {
      app.quit()
    })
  }
}
