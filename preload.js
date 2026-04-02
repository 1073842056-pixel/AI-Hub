/**
 * AI-Hub 预加载脚本
 * 在渲染进程与主进程之间建立安全的通信桥梁
 * 使用 contextBridge 暴露安全的 API 给前端
 */

const { contextBridge, ipcRenderer } = require('electron');

// 暴露给前端的安全 API
contextBridge.exposeInMainWorld('aiHub', {
  // ========== 配置管理 ==========
  
  /**
   * 获取保存的配置
   * @returns {Promise<{models: Array}>}
   */
  getConfig: () => ipcRenderer.invoke('get-config'),
  
  /**
   * 保存配置到本地
   * @param {Object} config - 配置对象
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // ========== AI 模型调用 ==========
  
  /**
   * 调用 AI 模型进行对话
   * @param {Object} params
   * @param {string} params.modelId - 模型 ID
   * @param {Array} params.messages - 消息列表
   * @param {boolean} params.stream - 是否使用流式输出
   * @returns {Promise<Object>}
   */
  callAI: (params) => ipcRenderer.invoke('call-ai', params),
  
  /**
   * 测试模型连接
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Object>}
   */
  testModel: (modelId) => ipcRenderer.invoke('test-model', modelId),
  
  // ========== 平台信息 ==========
  
  /**
   * 获取平台信息
   */
  platform: process.platform,
  
  /**
   * 检查是否为 Electron 环境
   */
  isElectron: true
});

console.log('[AI-Hub] Preload 脚本已加载');
