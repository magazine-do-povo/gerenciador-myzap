const { BrowserWindow } = require('electron');
const path = require('path');

let manualSetupWin = null;

function createManualSetupWindow() {
    if (manualSetupWin) {
        manualSetupWin.focus();
        return;
    }

    manualSetupWin = new BrowserWindow({
        width: 860,
        height: 820,
        minWidth: 820,
        minHeight: 760,
        autoHideMenuBar: true,
        backgroundColor: '#030712',
        webPreferences: {
            preload: path.join(__dirname, '../../src/loads/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    manualSetupWin.loadFile(path.join(__dirname, '../../assets/html/manualSetup.html'));
    manualSetupWin.on('closed', () => {
        manualSetupWin = null;
    });
}

module.exports = {
    createManualSetupWindow
};
