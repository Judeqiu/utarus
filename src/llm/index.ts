import { getModel, type Model } from '@earendil-works/pi-ai';
import { config } from '../config.js';

let deepseekModel: Model<'openai-completions'> | null = null;

export function getDeepSeekModel(): Model<'openai-completions'> {
  if (!deepseekModel) {
    if (!config.deepseek.apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required');
    }
    deepseekModel = getModel('deepseek', 'deepseek-v4-pro');
  }
  return deepseekModel;
}
