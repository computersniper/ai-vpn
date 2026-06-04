import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { logAction } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN_DIR = path.join(__dirname, '../bin');
const SINGBOX_EXE = path.join(BIN_DIR, 'sing-box.exe');
const ZIP_FILE = path.join(BIN_DIR, 'sing-box.zip');
const EXTRACTED_DIR = path.join(BIN_DIR, 'extracted');

const GITHUB_URL = 'https://github.com/SagerNet/sing-box/releases/download/v1.13.12/sing-box-1.13.12-windows-amd64.zip';
const MIRROR_URL = 'https://gh.llc/https://github.com/SagerNet/sing-box/releases/download/v1.13.12/sing-box-1.13.12-windows-amd64.zip';

// Helper to run shell command
function runCmd(command) {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Download file helper
async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Server returned status ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
  }
  fileStream.end();
}

export async function ensureSingbox() {
  if (fs.existsSync(SINGBOX_EXE)) {
    return SINGBOX_EXE;
  }

  logAction('system', 'info', 'sing-box.exe not found. Starting automatic download...');

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  // Try direct github first
  try {
    logAction('system', 'info', `Downloading sing-box from GitHub: ${GITHUB_URL}`);
    await downloadFile(GITHUB_URL, ZIP_FILE);
  } catch (err) {
    logAction('system', 'warn', `GitHub download failed: ${err.message}. Trying mirror...`);
    try {
      logAction('system', 'info', `Downloading sing-box from Mirror: ${MIRROR_URL}`);
      await downloadFile(MIRROR_URL, ZIP_FILE);
    } catch (mirrorErr) {
      logAction('system', 'error', `Mirror download also failed: ${mirrorErr.message}`);
      throw new Error('Failed to download sing-box core binary. Please download it manually and place it in backend/bin/sing-box.exe');
    }
  }

  logAction('system', 'info', 'Extracting sing-box archive...');
  
  // Natively extract using powershell Expand-Archive
  const psCmd = `powershell -Command "Expand-Archive -Path '${ZIP_FILE}' -DestinationPath '${EXTRACTED_DIR}' -Force"`;
  const extractRes = await runCmd(psCmd);
  
  if (!extractRes.success) {
    logAction('system', 'error', `Extraction failed: ${extractRes.stderr}`);
    throw new Error('Archive extraction failed.');
  }

  // Find the exe in the extracted path
  const subFolder = 'sing-box-1.13.12-windows-amd64';
  const sourceExe = path.join(EXTRACTED_DIR, subFolder, 'sing-box.exe');

  if (fs.existsSync(sourceExe)) {
    fs.renameSync(sourceExe, SINGBOX_EXE);
    logAction('system', 'info', 'sing-box.exe installed successfully!');
    
    // Clean up temporary files
    try {
      if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
      if (fs.existsSync(EXTRACTED_DIR)) fs.rmSync(EXTRACTED_DIR, { recursive: true, force: true });
    } catch (e) {
      // ignore cleanup errors
    }
    
    return SINGBOX_EXE;
  } else {
    logAction('system', 'error', `Could not find sing-box.exe in extracted archive. Expected at: ${sourceExe}`);
    throw new Error('sing-box.exe file missing in archive structure.');
  }
}
