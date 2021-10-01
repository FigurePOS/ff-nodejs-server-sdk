import Client from './client';
import { Options, Target } from './types';
import { Logger } from './log';
import { KeyValueStore } from './types';

export { Client, Options, Target, KeyValueStore, Logger };
export default {
  instance: undefined,
  init: function (sdkKey: string, options: Options): void {
    if (!this.instance) {
      this.instance = new Client(sdkKey, options);
    }
  },
  boolVariation: async function (
    identifier: string,
    target: Target,
    defaultValue = false,
  ): Promise<boolean> {
    return this.instance.boolVariation(identifier, target, defaultValue);
  },
  stringVariation: async function (
    identifier: string,
    target: Target,
    defaultValue = '',
  ): Promise<string> {
    return this.stringVariation(identifier, target, defaultValue);
  },
  numberVariation: async function (
    identifier: string,
    target: Target,
    defaultValue = 0,
  ): Promise<number> {
    return this.instance.numberVariation(identifier, target, defaultValue);
  },
  jsonVariation: async function (
    identifier: string,
    target: Target,
    defaultValue = '',
  ): Promise<Record<string, unknown>> {
    return this.instance.jsonVariation(identifier, target, defaultValue);
  },
  close: function(): void {
    return this.instance.close();
  }
};
