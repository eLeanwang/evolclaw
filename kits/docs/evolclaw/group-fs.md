# ec group fs 已废弃

群文件空间统一使用 `ec fs`，不再提供 `ec group fs` 入口。

迁移：

```bash
ec group fs ls <group-aid> /path
# 改为
ec fs ls <group-aid>:/path

ec group fs cp ./file <group-aid>:/path/file
# 改为
ec fs cp ./file <group-aid>:/path/file
```

当前可用能力以 `fs.md` 为准。群空间通过统一 `ec fs` 入口支持 `ls`、`stat`、`lstat`、`cat`、`cp`、`mv`、`rm`、`mkdir`、`find`、`df`、`mount`、`umount`；group facade 暂无接口的 `ln`、`chmod`、`setfacl`、`getfacl`、`token`、`approve`、`reject` 不在群 AID 上承诺可用。
