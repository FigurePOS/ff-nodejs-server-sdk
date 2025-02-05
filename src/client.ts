import EventEmitter from 'events';
import jwt_decode from 'jwt-decode';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import { Claims, Options, StreamEvent, Target } from './types';
import { Configuration, ClientApi, FeatureConfig, Variation } from './openapi';
import { VERSION } from './version';
import { PollerEvent, PollingProcessor } from './polling';
import { StreamProcessor } from './streaming';
import { Evaluator } from './evaluator';
import { defaultOptions } from './constants';
import { Repository, RepositoryEvent, StorageRepository } from './repository';
import {
  MetricEvent,
  MetricsProcessor,
  MetricsProcessorInterface,
} from './metrics';

axios.defaults.timeout = 30000;
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });
const log = defaultOptions.logger;

enum Processor {
  POLL,
  STREAM,
  METRICS,
}

export enum Event {
  READY = 'ready',
  FAILED = 'failed',
  CHANGED = 'changed',
}
export default class Client {
  private evaluator: Evaluator;
  private repository: Repository;
  private api: ClientApi;
  private sdkKey: string;
  private authToken: string;
  private environment: string;
  private configuration: Configuration;
  private options: Options;
  private cluster = '1';
  private eventBus = new EventEmitter();
  private pollProcessor: PollingProcessor;
  private streamProcessor: StreamProcessor;
  private metricsProcessor: MetricsProcessorInterface;
  private initialized = false;
  private failure = false;
  private waitForInitialize: Promise<Client>;
  private pollerReady = false;
  private streamReady = false;
  private metricReady = false;

  constructor(sdkKey: string, options: Options = {}) {
    this.sdkKey = sdkKey;
    if (options.pollInterval < 1000) {
      options.pollInterval = defaultOptions.pollInterval;
      log.warn('Polling interval cannot be lower than 1000 ms');
    }
    this.options = { ...defaultOptions, ...options };

    this.configuration = new Configuration({
      basePath: this.options.baseUrl,
      baseOptions: {
        headers: {
          'User-Agent': `NodeJsSDK/${VERSION}`,
        },
      },
    });

    this.repository = new StorageRepository(
      this.options.cache,
      this.options.store,
      this.eventBus,
    );
    this.evaluator = new Evaluator(this.repository);
    this.api = new ClientApi(this.configuration);
    this.processEvents();
    this.run();
  }

  private processEvents(): void {
    this.eventBus.on(PollerEvent.READY, () => {
      this.initialize(Processor.POLL);
    });

    this.eventBus.on(PollerEvent.ERROR, () => {
      this.failure = true;
      this.eventBus.emit(Event.FAILED);
    });

    this.eventBus.on(StreamEvent.READY, () => {
      this.initialize(Processor.STREAM);
    });

    this.eventBus.on(StreamEvent.ERROR, () => {
      this.failure = true;
      this.eventBus.emit(Event.FAILED);
    });

    this.eventBus.on(MetricEvent.READY, () => {
      this.initialize(Processor.METRICS);
    });

    this.eventBus.on(MetricEvent.ERROR, () => {
      this.failure = true;
      this.eventBus.emit(Event.FAILED);
    });

    this.eventBus.on(StreamEvent.CONNECTED, () => {
      this.pollProcessor.stop();
    });

    this.eventBus.on(StreamEvent.DISCONNECTED, () => {
      this.pollProcessor.start();
    });

    for (const event of Object.values(RepositoryEvent)) {
      this.eventBus.on(event, (identifier) => {
        switch (event) {
          case RepositoryEvent.FLAG_STORED:
          case RepositoryEvent.FLAG_DELETED:
            this.eventBus.emit(Event.CHANGED, identifier);
            break;
          case RepositoryEvent.SEGMENT_STORED:
          case RepositoryEvent.SEGMENT_DELETED:
            // find all flags where segment match and emit the event
            this.repository
              .findFlagsBySegment(identifier)
              .then((values: string[]) => {
                values.forEach((value) =>
                  this.eventBus.emit(Event.CHANGED, value),
                );
              });
            break;
        }
      });
    }
  }

  on(event: Event, callback: (...args: unknown[]) => void): void {
    const arrayObjects = [];

    for (const value of Object.values(Event)) {
      arrayObjects.push(value);
    }
    if (arrayObjects.includes(event)) {
      this.eventBus.on(event, callback);
    }
  }

  off(event?: string, callback?: () => void): void {
    if (event) {
      this.eventBus.off(event, callback);
    } else {
      this.close();
    }
  }

  private async authenticate(): Promise<void> {
    try {
      const response = await this.api.authenticate({
        apiKey: this.sdkKey,
      });
      this.authToken = response.data.authToken;
      this.configuration.accessToken = this.authToken;

      const decoded: Claims = jwt_decode(this.authToken);

      this.environment = decoded.environment;
      this.cluster = decoded.clusterIdentifier || '1';
    } catch (error) {
      this.failure = true;
      console.error('Error while authenticating, err: ', error);
    }
  }

  waitForInitialization(): Promise<Client> {
    if (this.waitForInitialize) {
      return this.waitForInitialize;
    }

    if (this.initialized) {
      this.waitForInitialize = Promise.resolve(this);
    } else if (this.failure) {
      this.waitForInitialize = Promise.reject(this.failure);
    } else {
      this.waitForInitialize = new Promise((resolve, reject) => {
        this.eventBus.once(Event.READY, () => {
          resolve(this);
        });
        this.eventBus.once(Event.FAILED, reject);
      });
    }
    return this.waitForInitialize;
  }

  private initialize(processor: Processor): void {
    switch (processor) {
      case Processor.POLL:
        this.pollerReady = true;
        log.debug('PollingProcessor ready');
        break;
      case Processor.STREAM:
        this.streamReady = true;
        log.debug('StreamingProcessor ready');
        break;
      case Processor.METRICS:
        this.metricReady = true;
        log.debug('MetricsProcessor ready');
        break;
    }

    if (this.options.enableStream && !this.streamReady) {
      return;
    }

    if (this.options.enableAnalytics && !this.metricReady) {
      return;
    }

    if (!this.pollerReady) {
      return;
    }

    this.initialized = true;
    this.eventBus.emit(Event.READY);
  }

  private async run(): Promise<void> {
    await this.authenticate();

    this.pollProcessor = new PollingProcessor(
      this.environment,
      this.cluster,
      this.api,
      this.options,
      this.eventBus,
      this.repository,
    );
    this.pollProcessor.start();

    if (this.options.enableStream) {
      this.streamProcessor = new StreamProcessor(
        this.api,
        this.sdkKey,
        this.environment,
        this.authToken,
        this.options,
        this.cluster,
        this.eventBus,
        this.repository,
      );

      this.streamProcessor.start();
    }

    if (this.options.enableAnalytics) {
      this.metricsProcessor = MetricsProcessor(
        this.environment,
        this.cluster,
        this.configuration,
        this.options,
        this.eventBus,
      );
      this.metricsProcessor.start();
    }

    log.info('finished setting up processors');
  }

  boolVariation(
    identifier: string,
    target: Target,
    defaultValue = false,
  ): Promise<boolean> {
    return this.evaluator.boolVariation(
      identifier,
      target,
      defaultValue,
      (fc: FeatureConfig, target: Target, variation: Variation) => {
        if (this.metricsProcessor) {
          this.metricsProcessor.enqueue(target, fc, variation);
        }
      },
    );
  }

  stringVariation(
    identifier: string,
    target: Target,
    defaultValue = '',
  ): Promise<string> {
    return this.evaluator.stringVariation(
      identifier,
      target,
      defaultValue,
      (fc: FeatureConfig, target: Target, variation: Variation) => {
        if (this.metricsProcessor) {
          this.metricsProcessor.enqueue(target, fc, variation);
        }
      },
    );
  }

  numberVariation(
    identifier: string,
    target: Target,
    defaultValue = 0,
  ): Promise<number> {
    return this.evaluator.numberVariation(
      identifier,
      target,
      defaultValue,
      (fc: FeatureConfig, target: Target, variation: Variation) => {
        if (this.metricsProcessor) {
          this.metricsProcessor.enqueue(target, fc, variation);
        }
      },
    );
  }

  jsonVariation(
    identifier: string,
    target: Target,
    defaultValue = {},
  ): Promise<Record<string, unknown>> {
    return this.evaluator.jsonVariation(
      identifier,
      target,
      defaultValue,
      (fc: FeatureConfig, target: Target, variation: Variation) => {
        if (this.metricsProcessor) {
          this.metricsProcessor.enqueue(target, fc, variation);
        }
      },
    );
  }

  close(): void {
    this.pollProcessor.close();
    if (this.streamProcessor) {
      this.streamProcessor.close();
    }
    if (this.metricsProcessor) {
      this.metricsProcessor.close();
    }
    this.eventBus.removeAllListeners();
  }
}
