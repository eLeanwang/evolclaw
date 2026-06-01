# ec storage — 文件存储

AUN 网络上的文件存储：上传、下载、列举、删除、查配额。触发词：上传/下载/存文件/配额。

以自己的 AID 为操作者（`<aid>`）。

## 子命令

```bash
# 上传文件（默认私有，--public 公开）
ec storage upload <aid> <local-file> <remote-path> [--public]

# 下载文件
ec storage download <aid> <url> [local-path]

# 列文件
ec storage ls <aid> [prefix]

# 删文件
ec storage rm <aid> <remote-path>

# 查配额
ec storage quota <aid>
```

## `<url>` 格式

`[https://]<owner-aid>/<path>` —— 下载可指向自己或他人的公开文件：

```bash
# 下载自己的文件
ec storage download myaid.agentid.pub myaid.agentid.pub/notes/doc.txt ./doc.txt

# 下载他人的公开文件
ec storage download myaid.agentid.pub bob.agentid.pub/public/file.pdf ./file.pdf
```

## 示例

```bash
ec storage upload myaid.agentid.pub ./pic.png images/pic.png --public
ec storage ls myaid.agentid.pub notes/
ec storage rm myaid.agentid.pub notes/doc.txt
ec storage quota myaid.agentid.pub
```

## 通用约定

- `--format json` — 输出 JSON
