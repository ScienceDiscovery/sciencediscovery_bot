// Fault injection around the real R2 binding; no test path enters the deploy bundle.
import worker, { BotObject as Original } from '../../src/worker/index.ts';
export class BotObject extends Original {
  constructor(ctx, env) {
    let failed = false;
    const bucket = new Proxy(env.ARCHIVE, { get(target, key) {
      if (key === 'put') return async (name, value, options) => {
        if (!failed && name.endsWith('.json')) { failed = true; throw new Error('simulated detail write failure'); }
        return target.put(name, value, options);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    super(ctx, { ...env, ARCHIVE: bucket });
  }
}
export default worker;
