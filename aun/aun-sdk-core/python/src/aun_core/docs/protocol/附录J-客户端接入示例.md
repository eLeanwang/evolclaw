## 12. 完整示例

> 以下示例以说明协议顺序和字段结构为主，属于最小接入样例。辅助函数如 `loadCert()`、`verifyPeerHelloReply()`、`signWithPrivateKey()` 仅为伪代码占位，实际 SDK 或生产实现需补充错误处理、超时控制、证书校验策略与连接重试。

### 12.1 Gateway 模式：浏览器应用完整流程

```javascript
// 1. 连接 Gateway
const ws = new WebSocket('wss://gateway.example.com/aun');
let msgId = 1;
let token = null;
let savedClientNonce = null;  // 保存 client_nonce 用于验证 Auth 服务签名
let savedRequestId = null;

ws.onopen = () => {
  // 连接建立后，initialize 之前只允许 auth.* 方法
  // 步骤1：发送 login_aid1（必需字段：aid, cert, request_id, client_nonce）
  savedRequestId = `req-${Date.now()}`;
  savedClientNonce = crypto.randomUUID();
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'auth.aid_login1',
    params: {
      aid: 'alice.aid.pub',
      cert: loadCert(),               // PEM 格式证书（必需）
      request_id: savedRequestId,     // 关联两阶段登录（必需）
      client_nonce: savedClientNonce   // 客户端随机 nonce（必需）
    }
  }));
};

// 处理响应和事件
ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  // login_aid1 响应：返回 nonce + client_nonce_signature + auth_cert
  if (msg.result && msg.result.nonce && msg.result.client_nonce_signature) {
    // 验证 Auth 服务身份：用 auth_cert 公钥验证 client_nonce_signature
    const authVerified = await verifyAuthSignature(
      msg.result.auth_cert, savedClientNonce, msg.result.client_nonce_signature
    );
    if (!authVerified) throw new Error('Auth 服务身份验证失败');

    // 步骤2：对 server nonce 签名，提交 login_aid2
    const signature = await signWithPrivateKey(msg.result.nonce);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'auth.aid_login2',
      params: {
        aid: 'alice.aid.pub',
        request_id: savedRequestId,
        nonce: msg.result.nonce,
        signature: signature,
        cert: loadCert()
      }
    }));
  }

  // login_aid2 响应（获得 token，但连接状态未变）
  if (msg.result && msg.result.token && !msg.result.authenticated) {
    token = msg.result.token;

    // 步骤3：用 token 调用 initialize 完成 Gateway 模式认证握手
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'initialize',
      params: {
        mode: 'gateway',
        protocol: {min: '1.0', max: '1.0'},
        token: token,
        clientInfo: {name: 'MyApp', version: '1.0.0'}
      }
    }));
  }

  // initialize 响应（连接已认证）
  if (msg.result && msg.result.authenticated) {
    console.log('Authenticated as:', msg.result.identity.aid);

    // 现在可以调用所有方法
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'message.send',
      params: {
        to: 'bob.aid.pub',
        type: 'text',
        payload: {text: 'Hello Bob!'}
      }
    }));
  }

  // 收到消息事件
  if (msg.method === 'event/message.received') {
    console.log('Message from', msg.params.from, ':', msg.params.payload?.text);
  }
};
```

发送附件时，不应在 `payload` 中直接嵌入文件二进制，而应携带 `storage.*` 返回的对象引用：

```javascript
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: msgId++,
  method: 'message.send',
  params: {
    to: 'bob.aid.pub',
    type: 'file',
    payload: {
      text: '请查收附件',
      attachments: [
        {
          url: 'https://storage.example.com/objects/default/docs/report.pdf',
          bucket: 'default',
          object_key: 'docs/report.pdf',
          filename: 'report.pdf',
          size: 245678,
          sha256: '3d8e577bddb17db339eae0b3d9bcf180f48c3f1a12f5f7ddce9f4ea7d3c1af4a',
          content_type: 'application/pdf'
        }
      ]
    },
    persist: true
  }
}));
```

### 12.2 Gateway 模式：移动应用完整流程（iOS）

```swift
// 1. 连接 Gateway
var request = URLRequest(url: URL(string: "wss://gateway.example.com/aun")!)
let ws = WebSocket(request: request)
var msgId = 1
var token: String?
var savedClientNonce: String?
var savedRequestId: String?

// 2. 连接成功后，先调用 auth.* 获取 token（initialize 之前只允许 auth.*）
ws.onConnected = {
    savedRequestId = UUID().uuidString
    savedClientNonce = UUID().uuidString
    ws.send(jsonrpc: "2.0", id: msgId, method: "auth.aid_login1",
           params: [
               "aid": "alice.aid.pub",
               "cert": loadCert(),                    // PEM 格式证书（必需）
               "request_id": savedRequestId!,         // 关联两阶段登录（必需）
               "client_nonce": savedClientNonce!       // 客户端随机 nonce（必需）
           ])
    msgId += 1
}

// 3. 处理响应和事件
ws.onMessage = { message in
    // login_aid1 响应：返回 nonce + client_nonce_signature + auth_cert
    if let loginResp = message as? LoginAid1Response {
        // 验证 Auth 服务身份：用 auth_cert 公钥验证 client_nonce_signature
        guard verifyAuthSignature(
            authCert: loginResp.authCert,
            clientNonce: savedClientNonce!,
            signature: loginResp.clientNonceSignature
        ) else { fatalError("Auth 服务身份验证失败") }

        // 对 server nonce 签名，提交 login_aid2
        let signature = signWithPrivateKey(loginResp.nonce)
        ws.send(jsonrpc: "2.0", id: msgId, method: "auth.aid_login2",
               params: [
                   "aid": "alice.aid.pub",
                   "request_id": savedRequestId!,
                   "nonce": loginResp.nonce,
                   "signature": signature,
                   "cert": loadCert()
               ])
        msgId += 1
    }

    // login_aid2 响应（获得 token，但连接状态未变）
    if let loginResp = message as? LoginAid2Response {
        token = loginResp.token

        // 用 token 调用 initialize 完成 Gateway 模式认证握手
        let initMsg = InitializeRequest(
            mode: "gateway",
            protocol: ProtocolRange(min: "1.0", max: "1.0"),
            token: token!,
            clientInfo: ClientInfo(name: "MyApp", version: "1.0.0")
        )
        ws.send(jsonrpc: "2.0", id: msgId, method: "initialize", params: initMsg)
        msgId += 1
    }

    // initialize 响应（连接已认证）
    if let response = message as? InitializeResponse, response.authenticated {
        print("Authenticated as: \(response.identity.aid)")

        // 现在可以调用所有方法
        ws.send(jsonrpc: "2.0", id: msgId, method: "message.send",
               params: [
                   "to": "bob.aid.pub",
                   "type": "text",
                   "payload": ["text": "Hello Bob!"]
               ])
        msgId += 1
    }

    // 收到消息事件
    if let event = message as? MessageReceivedEvent {
        print("Message from \(event.from): \(event.payload["text"] ?? "")")
    }
}
```

### 12.3 Peer 模式：最小直连接入示例

```javascript
const ws = new WebSocket('wss://bob.company.com:9900/acp');
let msgId = 1;
let localNonce = crypto.randomUUID();

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'initialize',
    params: {
      mode: 'peer',
      protocol: {min: '1.0', max: '1.0'},
      clientInfo: {name: 'PeerClient', version: '1.0.0'}
    }
  }));

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'peer.hello',
    params: {
      aid: 'alice.aid.pub',
      cert: loadCert(),
      nonce: localNonce,
      protocol: {min: '1.0', max: '1.0'}
    }
  }));
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.result?.nonce && msg.result?.nonce_signature && msg.result?.cert) {
    const peerOk = await verifyPeerHelloReply(
      msg.result.cert,
      localNonce,
      msg.result.nonce_signature
    );
    if (!peerOk) throw new Error('Peer 身份验证失败');

    const replySignature = await signWithPrivateKey(msg.result.nonce);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'peer.confirm',
      params: {
        nonce_signature: replySignature
      }
    }));
  }

  if (msg.result?.authenticated) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'message.send',
      params: {
        to: 'bob.company.com',
        type: 'text',
        payload: {text: 'Hello from peer mode'}
      }
    }));
  }
};
```

### 12.4 Relay 模式：最小中继接入示例

```javascript
const ws = new WebSocket('wss://relay.aun.network:9800/relay');
let msgId = 1;
let localNonce = crypto.randomUUID();

ws.onopen = () => {
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'initialize',
    params: {
      mode: 'relay',
      protocol: {min: '1.0', max: '1.0'},
      clientInfo: {name: 'RelayClient', version: '1.0.0'}
    }
  }));

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'relay.register',
    params: {
      aid: 'alice.aid.pub'
    }
  }));

  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: msgId++,
    method: 'relay.forward',
    params: {
      to: 'bob.company.com',
      message: {
        jsonrpc: '2.0',
        id: msgId++,
        method: 'peer.hello',
        params: {
          aid: 'alice.aid.pub',
          cert: loadCert(),
          nonce: localNonce,
          protocol: {min: '1.0', max: '1.0'}
        }
      }
    }
  }));
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  if (msg.method === 'event/relay.message' && msg.params?.message?.result?.nonce_signature) {
    const inner = msg.params.message.result;
    const peerOk = await verifyPeerHelloReply(inner.cert, localNonce, inner.nonce_signature);
    if (!peerOk) throw new Error('Relay 上的对端身份验证失败');

    const replySignature = await signWithPrivateKey(inner.nonce);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'relay.forward',
      params: {
        to: 'bob.company.com',
        message: {
          jsonrpc: '2.0',
          id: msgId++,
          method: 'peer.confirm',
          params: {
            nonce_signature: replySignature
          }
        }
      }
    }));
  }

  if (msg.method === 'event/relay.message' && msg.params?.message?.result?.authenticated) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: msgId++,
      method: 'relay.forward',
      params: {
        to: 'bob.company.com',
        message: {
          jsonrpc: '2.0',
          id: msgId++,
          method: 'message.send',
          params: {
            to: 'bob.company.com',
            type: 'text',
            payload: {text: 'Hello from relay mode'}
          }
        }
      }
    }));
  }
};
```

---
