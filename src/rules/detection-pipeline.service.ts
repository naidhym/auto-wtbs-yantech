import type { ChannelMessageProcessor } from '../channels/channel.types.js';
import type { DetectionEvent } from './rule.types.js';
import type { GlobalDetectionEvent } from './global-detection.service.js';
import { DetectionService } from './detection.service.js';
import { GlobalDetectionService } from './global-detection.service.js';

export interface DetectionPipelineResult {
  readonly globalEvent: GlobalDetectionEvent | undefined;
  readonly ruleEvents: DetectionEvent[];
}

export class DetectionPipelineService {
  public constructor(
    private readonly globalDetection: GlobalDetectionService,
    private readonly channelRules: DetectionService,
  ) {}

  public process(
    input: Parameters<ChannelMessageProcessor['process']>[0],
  ): DetectionPipelineResult {
    const globalEvent = this.globalDetection.process(input);
    if (
      input.message.chatKind !== 'channel_post' ||
      input.message.telegramChannelId !== input.channel.telegramChannelId
    ) {
      return { globalEvent, ruleEvents: [] };
    }

    return {
      globalEvent,
      ruleEvents: this.channelRules.process(input),
    };
  }
}
