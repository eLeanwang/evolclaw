type ChannelFactory = (config: any) => any;
type AgentFactory = (config: any) => any;

export class ChannelRegistry {
  private factories = new Map<string, ChannelFactory>();
  register(name: string, factory: ChannelFactory): void { this.factories.set(name, factory); }
  create(name: string, config: any): any {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown channel: ${name}`);
    return factory(config);
  }
  has(name: string): boolean { return this.factories.has(name); }
}

export class AgentRegistry {
  private factories = new Map<string, AgentFactory>();
  register(name: string, factory: AgentFactory): void { this.factories.set(name, factory); }
  create(name: string, config: any): any {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown agent: ${name}`);
    return factory(config);
  }
}
