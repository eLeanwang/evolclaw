import readline from 'readline';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export interface OverwriteChoice {
  action: 'overwrite';
  index: number;
  name: string;
}

export interface AddChoice {
  action: 'add';
  name: string;
}

export type InstanceChoice = OverwriteChoice | AddChoice;

/**
 * Present instance selection menu when existing instances are found.
 * Returns the user's choice, or null if cancelled.
 */
export async function selectInstance(
  rl: readline.Interface,
  channelType: string,
  instances: Array<{ name: string; [key: string]: any }>
): Promise<InstanceChoice | null> {
  const typeLabel = channelType === 'feishu' ? '飞书' : channelType === 'wechat' ? '微信' : 'AUN';
  console.log(`\n发现已有 ${typeLabel} 机器人：`);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < instances.length; i++) {
    console.log(`  ${letters[i]}. ${instances[i].name}`);
  }
  const addLetter = letters[instances.length];
  console.log(`  ${addLetter}. 添加新机器人`);
  console.log('');

  const validOptions = letters.slice(0, instances.length + 1);
  let choice = '';
  while (!validOptions.includes(choice)) {
    choice = (await ask(rl, '请选择: ')).trim().toLowerCase();
    if (!validOptions.includes(choice)) {
      console.log(`无效选择，请输入 ${validOptions.split('').join('/')}`);
    }
  }

  const choiceIndex = letters.indexOf(choice);
  if (choiceIndex === instances.length) {
    // Add new — ask for name
    let name = '';
    while (!name) {
      name = (await ask(rl, '请输入新机器人名称: ')).trim();
      if (!name) console.log('  名称不能为空');
      if (instances.some(i => i.name === name)) {
        console.log(`  名称 "${name}" 已存在，请换一个`);
        name = '';
      }
    }
    return { action: 'add', name };
  }

  // Overwrite — requires confirmation
  const target = instances[choiceIndex];
  const confirm = (await ask(rl, `即将覆盖 "${target.name}" 的配置，确认？(y/N) `)).trim().toLowerCase();
  if (confirm !== 'y' && confirm !== 'yes') {
    console.log('已取消');
    return null;
  }

  return { action: 'overwrite', index: choiceIndex, name: target.name };
}
