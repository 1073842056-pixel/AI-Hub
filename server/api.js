/**
 * AI-Hub Express API 服务
 * 代理 AI 模型 API 请求，统一处理流式输出
 * 端口: 3000
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

// CORS 允许 Electron 访问
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================
// 配置管理
// ============================================

/**
 * 获取配置路径
 */
function getConfigPath() {
  // 尝试多个位置查找配置文件
  const possiblePaths = [
    path.join(process.env.APPDATA || '', 'ai-hub', 'config.json'),
    path.join(__dirname, '..', 'config.json'),
    path.join(__dirname, '..', '..', 'config.json')
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

/**
 * 加载配置
 */
function loadConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('[API] 加载配置失败:', e.message);
  }
  return { models: [] };
}

/**
 * 保存配置
 */
function saveConfig(config) {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// ============================================
// API 路由
// ============================================

/**
 * 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * 获取配置（脱敏版，用于前端展示）
 */
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  if (config.models) {
    config.models = config.models.map(m => ({
      ...m,
      apiKey: m.apiKey ? '***' + m.apiKey.slice(-4) : ''
    }));
  }
  res.json(config);
});

/**
 * 获取原始配置（包含真实 API Key，仅内部使用）
 */
app.get('/api/config/raw', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

/**
 * 保存配置
 */
app.post('/api/config', (req, res) => {
  try {
    const config = req.body;
    saveConfig(config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 测试模型连接
 */
app.get('/api/test/:modelId', async (req, res) => {
  const { modelId } = req.params;
  const config = loadConfig();
  const model = config.models.find(m => m.id === modelId);
  
  if (!model) {
    return res.status(404).json({ success: false, error: '模型不存在' });
  }
  
  if (!model.enabled) {
    return res.status(400).json({ success: false, error: '模型未启用' });
  }
  
  try {
    // 发送一个简单的测试请求
    const response = await axios.post(
      `${model.baseUrl}/chat/completions`,
      {
        model: model.modelName,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`
        },
        timeout: 10000
      }
    );
    
    res.json({ success: true, response: response.data });
  } catch (e) {
    res.status(500).json({ 
      success: false, 
      error: e.response?.data?.error?.message || e.message 
    });
  }
});

/**
 * AI 对话接口（核心）
 * 支持流式输出 (Server-Sent Events)
 */
app.post('/api/chat', async (req, res) => {
  const { modelId, messages, stream = false } = req.body;
  
  if (!modelId || !messages) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  
  const config = loadConfig();
  const model = config.models.find(m => m.id === modelId);

  if (!model) {
    return res.status(404).json({ error: '模型不存在' });
  }

  if (!model.enabled) {
    return res.status(400).json({ error: '模型未启用' });
  }

  // 根据不同模型选择合适的 API 端点
  let endpoint = `${model.baseUrl}/chat/completions`;
  let headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${model.apiKey}`
  };

  // Anthropic Claude 特殊处理
  if (model.baseUrl.includes('anthropic')) {
    endpoint = `${model.baseUrl}/messages`;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': model.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }
  
  try {
    // 从请求中获取温度参数（默认为 0.2）
    const temperature = parseFloat(req.body.temperature) || 0.2;
    
    // 构建请求体（兼容不同 API 格式）
    let requestBody = {
      model: model.modelName,
      messages: messages,
      stream: stream
    };
    
    // Anthropic 格式
    if (model.baseUrl.includes('anthropic')) {
      requestBody = {
        model: model.modelName,
        messages: messages,
        max_tokens: 4096
      };
    }
    
    // 如果 temperature > 0（0 表示使用默认值），添加到请求体
    if (temperature > 0) {
      requestBody.temperature = temperature;
    }
    
    if (stream) {
      // 流式响应：使用 Server-Sent Events
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      const response = await axios.post(endpoint, requestBody, {
        headers,
        responseType: 'stream',
        timeout: 120000
      });
      
      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write('data: [DONE]\n\n');
            } else {
              try {
                const parsed = JSON.parse(data);
                // 统一格式
                let content = '';
                if (parsed.choices?.[0]?.delta?.content) {
                  content = parsed.choices[0].delta.content;
                } else if (parsed.type === 'content_block_delta') {
                  content = parsed.content?.text || '';
                }
                if (content) {
                  res.write(`data: ${JSON.stringify({ content })}\n\n`);
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
      });
      
      response.data.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('[API] 流式响应错误:', err.message);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      });
      
    } else {
      // 非流式响应
      const response = await axios.post(endpoint, requestBody, {
        headers,
        timeout: 120000
      });
      
      // 统一返回格式
      let content = '';
      if (response.data.choices?.[0]?.message?.content) {
        content = response.data.choices[0].message.content;
      } else if (response.data.content?.[0]?.text) {
        content = response.data.content[0].text;
      }
      
      res.json({ 
        success: true, 
        content,
        raw: response.data 
      });
    }
    
  } catch (e) {
    console.error('[API] 请求错误:', e.message);
    const errorMsg = e.response?.data?.error?.message || 
                     e.response?.data?.error?.type ||
                     e.message;
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// 获取支持的模型列表
app.get('/api/models/:provider', (req, res) => {
  const { provider } = req.params;
  
  const models = {
    deepseek: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', description: '最新最强模型' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', description: '推理专家' }
    ],
    minimax: [
      { id: 'abab6.5s-chat', name: 'ABAB 6.5S', description: '日常对话' },
      { id: 'abab6-chat', name: 'ABAB 6', description: '增强版' }
    ],
    openai: [
      { id: 'gpt-4o', name: 'GPT-4o', description: '最新旗舰' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: '轻量快速' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: '高性能' }
    ],
    anthropic: [
      { id: 'claude-opus-4', name: 'Claude Opus 4', description: '最强大模型' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: '均衡之选' },
      { id: 'claude-haiku-4', name: 'Claude Haiku 4', description: '轻量快速' }
    ],
    siliconflow: [
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 72B', description: '通义千问' },
      { id: 'deepseek-ai/DeepSeek-V2.5', name: 'DeepSeek V2.5', description: '高效低成本' }
    ]
  };
  
  res.json(models[provider] || []);
});

// ============================================
// 模型管理 API
// ============================================

/**
 * 获取提供商列表（从已配置的模型中提取）
 */
app.get('/api/providers', (req, res) => {
  const config = loadConfig();
  const modelMap = {};
  (config.models || []).forEach(m => {
    if (!modelMap[m.provider]) {
      modelMap[m.provider] = {
        name: m.provider,
        displayName: m.provider.charAt(0).toUpperCase() + m.provider.slice(1),
        models: []
      };
    }
    modelMap[m.provider].models.push(m);
  });
  res.json(Object.values(modelMap));
});

/**
 * 添加模型
 */
app.post('/api/models/add', (req, res) => {
  try {
    const { id, provider, name, apiKey, baseUrl, modelName, enabled } = req.body;
    if (!id || !provider || !modelName) {
      return res.status(400).json({ success: false, error: '缺少必填字段' });
    }
    const config = loadConfig();
    // 检查是否已存在
    if (config.models.find(m => m.id === id)) {
      return res.status(400).json({ success: false, error: '模型 ID 已存在' });
    }
    config.models.push({ id, provider, name: name || modelName, apiKey: apiKey || '', baseUrl: baseUrl || '', modelName, enabled: enabled !== false });
    saveConfig(config);
    res.json({ success: true, model: config.models.find(m => m.id === id) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 更新模型
 */
app.put('/api/models/:id', (req, res) => {
  try {
    const { id } = req.params;
    const config = loadConfig();
    const idx = config.models.findIndex(m => m.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: '模型不存在' });
    }
    config.models[idx] = { ...config.models[idx], ...req.body, id }; // 确保 ID 不被覆盖
    saveConfig(config);
    res.json({ success: true, model: config.models[idx] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 删除模型
 */
app.delete('/api/models/:id', (req, res) => {
  try {
    const { id } = req.params;
    const config = loadConfig();
    const idx = config.models.findIndex(m => m.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: '模型不存在' });
    }
    config.models.splice(idx, 1);
    saveConfig(config);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`[AI-Hub API] 服务已启动 http://localhost:${PORT}`);
  console.log(`[AI-Hub API] 配置文件路径: ${getConfigPath()}`);
});
