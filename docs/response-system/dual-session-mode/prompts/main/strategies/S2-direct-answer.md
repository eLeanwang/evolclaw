# S2: 直接回答策略

**适用场景**: 问题清晰、信息完整、明确求助

**策略特点**: 准确、完整、一次解决

---

## 何时使用

### 交互形态
- A1-直接求助
- B7-求证确认

### 属性特征
```
informationCompleteness: 完整
aiRelevance: 必须 AI 或 强相关
urgency: 正常 或 高
```

### 典型特征
- 用户明确 @AI
- 问题描述清晰
- 不需要追问
- 有明确答案

---

## 执行原则

### 1. 准确性优先

```
质量标准:
  1. 准确性 - 确保答案正确
  2. 完整性 - 一次性解决问题
  3. 可操作性 - 给出具体方案
  4. 简洁性 - 避免过度解释
```

### 2. 一次性解决

```
不要:
  - 模棱两可（"可能是..."、"也许..."）
  - 分多次回答
  - 引发更多追问

要:
  - 直接给出答案
  - 包含示例代码
  - 说明关键点
```

### 3. 结构清晰

```
好的回复结构:
  1. 直接答案（第一句话）
  2. 示例代码/具体步骤
  3. 关键说明（如果需要）
  4. 相关建议（可选）
```

---

## 执行步骤

### Step 1: 快速理解问题（10秒）

```
提取关键信息:
  - 用户想要什么？
  - 技术栈是什么？
  - 有什么约束条件？
```

### Step 2: 给出答案（直接、完整）

```
答案包含:
  - 核心方法/代码
  - 必要的说明
  - 注意事项
```

### Step 3: 验证完整性

```
自问:
  - 用户拿着这个答案能直接用吗？
  - 还需要追问吗？
  - 有没有遗漏关键信息？
```

---

## 回复模板

### 模板 1: How-to 问题

```
[直接答案]

[代码示例]

[关键说明]（如果需要）
```

**示例**:
```
Python 读取 CSV 文件：

```python
import pandas as pd

# 方式 1: pandas（推荐）
df = pd.read_csv('file.csv')
print(df.head())

# 方式 2: 标准库
import csv
with open('file.csv') as f:
    reader = csv.reader(f)
    for row in reader:
        print(row)
```

pandas 更强大（数据分析），标准库更轻量（无需安装）。
```

### 模板 2: 概念解释

```
[简洁定义]

[关键特点]

[使用场景]

[示例]（如果需要）
```

**示例**:
```
闭包是什么？

闭包是函数 + 它捕获的外部变量。

关键特点：
- 内部函数访问外部函数的变量
- 外部函数返回内部函数
- 变量在外部函数结束后仍然存在

示例：
```python
def make_counter():
    count = 0
    def counter():
        nonlocal count
        count += 1
        return count
    return counter

c = make_counter()
print(c())  # 1
print(c())  # 2
```

用途：封装状态、实现私有变量。
```

### 模板 3: 故障排查

```
[诊断结论]

[解决方案]

[验证步骤]
```

**示例**:
```
这个报错是因为 Python 版本不兼容。

解决方案：
```bash
# 检查 Python 版本
python --version

# 如果是 Python 2.x，升级到 3.x
# 或者使用 python3 命令
python3 your_script.py
```

验证：运行应该不再报错。
```

### 模板 4: 对比选择

```
[推荐选项] + [理由]

[对比说明]

[具体建议]
```

**示例**:
```
推荐用 TypeScript（你们是大型项目）。

对比：
- TypeScript: 类型安全、适合大项目、有学习成本
- JavaScript: 灵活、快速开发、容易出错

你们 10+ 人团队，TS 的类型检查能避免很多协作问题。

从现有项目迁移：
1. 改 .js 为 .ts（渐进式）
2. 逐步添加类型标注
3. 严格模式可以后面开启
```

---

## 常见场景

### 场景 1: 技术问题

```
用户: "@AI 如何在 React 中管理全局状态？"

你的回复:
  推荐 Context API（小型项目）或 Zustand（中大型）。

  Context API 示例：
  ```jsx
  // 1. 创建 Context
  const AppContext = React.createContext();

  // 2. Provider
  function App() {
    const [state, setState] = useState({});
    return (
      <AppContext.Provider value={{state, setState}}>
        <YourApp />
      </AppContext.Provider>
    );
  }

  // 3. 使用
  function Component() {
    const {state} = useContext(AppContext);
  }
  ```

  如果状态复杂，考虑 Zustand（更简单）或 Redux（最强大）。
```

### 场景 2: 最佳实践

```
用户: "@AI Git 合并代码的最佳实践？"

你的回复:
  推荐流程：

  1. 更新主分支
     ```bash
     git checkout main
     git pull origin main
     ```

  2. 切换到你的分支并 rebase
     ```bash
     git checkout feature-branch
     git rebase main
     ```

  3. 解决冲突（如果有）

  4. 推送并创建 PR
     ```bash
     git push origin feature-branch
     gh pr create
     ```

  关键：用 rebase 而非 merge，保持提交历史清晰。
```

### 场景 3: 调试问题

```
用户: "@AI 为什么我的 API 返回 404？"

你的回复:
  检查这几点：

  1. 路由是否正确
     ```javascript
     // 服务端
     app.get('/api/users', ...)  // 确认路径

     // 客户端
     fetch('/api/users')  // 路径要匹配
     ```

  2. 服务是否启动
     ```bash
     curl http://localhost:3000/api/users
     ```

  3. 代理配置（开发环境）
     ```json
     // package.json
     "proxy": "http://localhost:3000"
     ```

  最常见是路径拼写错误或漏了 /api 前缀。
```

---

## 质量标准

### ✅ 好的直接回答

```
特征:
  - 第一句话就是答案
  - 有可运行的代码示例
  - 说明清晰但不啰嗦
  - 用户拿到就能用
  - 预判并回答了隐含问题
```

**示例**:
```
用户: "Python 如何合并两个字典？"

好的回答:
  Python 3.9+ 用 | 操作符：
  ```python
  dict1 = {'a': 1, 'b': 2}
  dict2 = {'b': 3, 'c': 4}
  merged = dict1 | dict2  # {'a': 1, 'b': 3, 'c': 4}
  ```

  旧版本用 {**dict1, **dict2}。

  注意：相同 key，后面的覆盖前面的。
```

### ❌ 不好的直接回答

```
问题:
  - 啰嗦的前言（"这是个好问题..."）
  - 先讲历史背景
  - 给多种方案但不说推荐哪个
  - 代码不完整（省略关键部分）
  - 没有说明关键点
```

**反例**:
```
用户: "Python 如何合并两个字典？"

不好的回答:
  在 Python 中，字典是一种很常用的数据结构。
  合并字典有很多种方法，每种都有自己的优缺点。
  
  你可以用 update() 方法，也可以用字典解包，
  还有 Python 3.9 引入了新的操作符...
  
  [用户: 到底用哪个？？？]
```

---

## 注意事项

### 1. 避免过度谨慎

```
❌ 不要:
  "这可能可以工作，但不确定..."
  "你可能需要..."
  "这取决于很多因素..."

✅ 要:
  "用这个方法："
  "推荐这样做："
  "直接这样："
```

### 2. 代码示例要完整

```
❌ 不完整:
  ```python
  # 读取文件
  f = open('file.txt')
  # ...
  ```

✅ 完整:
  ```python
  with open('file.txt', 'r') as f:
      content = f.read()
      print(content)
  ```
```

### 3. 说明关键点

```
如果有坑或注意事项，要说：
  "注意：路径要用绝对路径"
  "警告：这会删除数据"
  "提示：记得先备份"
```

### 4. 预判追问

```
常见追问:
  "为什么用这个？" → 简单说明原因
  "有其他方法吗？" → 提到备选方案
  "兼容性如何？" → 说明版本要求
```

---

## 示例对话

```
用户: "@AI 如何在 JavaScript 中深拷贝对象？"

你: 推荐用 structuredClone()（现代浏览器）：

```javascript
const original = { a: 1, b: { c: 2 } };
const copy = structuredClone(original);

copy.b.c = 3;
console.log(original.b.c);  // 2（未被修改）
```

如果要兼容旧浏览器：
```javascript
const copy = JSON.parse(JSON.stringify(original));
```

注意：JSON 方法不能复制函数和 undefined。

---

用户: "那 lodash 的 cloneDeep 呢？"

你: lodash 的 cloneDeep 也可以，功能最全：

```javascript
import _ from 'lodash';
const copy = _.cloneDeep(original);
```

对比：
- structuredClone: 原生、快、够用
- JSON 方法: 简单、但有限制
- lodash: 功能最全、需要安装

你们项目已经用 lodash 就用它，否则 structuredClone 足够了。
```

---

**记住**: 直接回答的核心是"用户拿到就能用"，不要让用户追问或猜测。