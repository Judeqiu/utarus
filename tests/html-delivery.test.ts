import { describe, it, expect } from 'vitest';
import { wantsHtmlDelivery } from '../src/report/html-delivery.js';

describe('wantsHtmlDelivery', () => {
  it('detects explicit HTML requests', () => {
    expect(wantsHtmlDelivery('please give me this as html')).toBe(true);
    expect(wantsHtmlDelivery('Generate an HTML report of my portfolio')).toBe(true);
    expect(wantsHtmlDelivery('export html page with the analysis')).toBe(true);
    expect(wantsHtmlDelivery('post HTML of the full write-up')).toBe(true);
  });

  it('detects full report as file/link phrasing', () => {
    expect(wantsHtmlDelivery('full report as a document link')).toBe(true);
    expect(wantsHtmlDelivery('analysis report in browser')).toBe(true);
  });

  it('ignores normal chat', () => {
    expect(wantsHtmlDelivery('analyze my portfolio')).toBe(false);
    expect(wantsHtmlDelivery('what is the price of AAPL')).toBe(false);
    expect(wantsHtmlDelivery('')).toBe(false);
  });
});
