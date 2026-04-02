/**
 * AI-Hub Electron 主进程
 * 负责创建窗口、管理应用生命周期
 * 使用 file:// 协议加载前端页面
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { fork } = require('child_process');

// Express API 服务进程
let apiServer = null;

// 应用入口
app.whenReady().then(() => {
  console.log('[AI-Hub] 应用启动...');
  
  // 启动 Express API 服务
  startApiServer();
  
  // 创建主窗口
  createWindow();
  
  // macOS 特性：点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 退出应用时确保 API 服务也关闭
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (apiServer) apiServer.kill();
    app.quit();
  }
});

app.on('before-quit', () => {
  if (apiServer) apiServer.kill();
});

/**
 * 启动 Express API 服务作为子进程
 * 避免 Electron 主进程与 Express 冲突
 */
function startApiServer() {
  const serverPath = path.join(__dirname, 'server', 'api.js');
  apiServer = fork(serverPath, [], {
    stdio: 'pipe'
  });
  
  apiServer.stdout.on('data', (data) => {
    console.log('[API Server]', data.toString());
  });
  
  apiServer.stderr.on('data', (data) => {
    console.error('[API Server Error]', data.toString());
  });
  
  console.log('[AI-Hub] API 服务已启动 (端口 3000)');
}

/**
 * 创建主窗口
 */
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'AI Hub',
    backgroundColor: '#000000',
    webPreferences: {
      // preload.js 脚本 - 安全桥接主进程与渲染进程
      preload: path.join(__dirname, 'preload.js'),
      // 允许加载本地文件
      webSecurity: true,
      contextIsolation: true,  // 启用上下文隔离
      nodeIntegration: false    // 禁用 Node.js 直接访问
    }
  });
  
  // 加载主页面
  mainWindow.loadFile(path.join(__dirname, 'web', 'index.html'));
  
  // 打开开发者工具（调试用）
  // mainWindow.webContents.openDevTools();
  
  console.log('[AI-Hub] 主窗口已创建');
}

// ============================================
// IPC 通信处理
// ============================================

// 获取配置
ipcMain.handle('get-config', () => {
  const fs = require('fs');
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('[AI-Hub] 读取配置失败:', e);
  }
  return { models: [] };
});

// 保存配置
ipcMain.handle('save-config', (event, config) => {
  const fs = require('fs');
  const configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    console.error('[AI-Hub] 保存配置失败:', e);
    return { success: false, error: e.message };
  }
});

// 调用 AI 模型（通过 Express API）
ipcMain.handle('call-ai', async (event, { modelId, messages, stream }) => {
  try {
    const response = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, messages, stream })
    });
    
    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }
    
    if (stream) {
      // 流式响应：返回 ReadableStream
      return { success: true, stream: true, data: response.body };
    } else {
      const data = await response.json();
      return { success: true, data };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// 测试模型连接
ipcMain.handle('test-model', async (event, modelId) => {
  try {
    const response = await fetch('http://localhost:3000/api/test/' + modelId, {
      method: 'GET'
    });
    const data = await response.json();
    return data;
  } catch (e) {
    return { success: false, error: e.message };
  }
});
