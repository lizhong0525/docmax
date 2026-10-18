/**
 * 词级差异视图：直接渲染 core/diff.ts 的 computeDiff 结果。
 * 删除用删除线（朱砂红），新增用下划线 + 浅底（强调色），相同内容保持正文语气。
 */
import { useMemo } from 'react';
import { computeDiff } from '../core/diff';
import { formatCount } from './labels';

export interface DiffViewProps {
  before: string;
  after: string;
  /** 大段文本时限制渲染片段数，避免 DOM 过重 */
  maxSegments?: number;
}

export function DiffView({ before, after, maxSegments = 3000 }: DiffViewProps) {
  const diff = useMemo(() => computeDiff(before, after), [before, after]);
  const segments = diff.segments.length > maxSegments ? diff.segments.slice(0, maxSegments) : diff.segments;

  if (diff.identical) {
    return (
      <div className="diff diff-identical" data-testid="diff">
        <span className="diff-eq">{after}</span>
      </div>
    );
  }

  return (
    <div className="diff-wrap">
      <div className="diff-metrics" aria-hidden="true">
        <span className="diff-minus">−{formatCount(diff.removedChars)}</span>
        <span className="diff-plus">+{formatCount(diff.addedChars)}</span>
      </div>
      <div className="diff" data-testid="diff">
        {segments.map((segment, index) => {
          if (segment.type === 'removed') {
            return (
              <del className="diff-del" key={index}>
                {segment.text}
              </del>
            );
          }
          if (segment.type === 'added') {
            return (
              <ins className="diff-add" key={index}>
                {segment.text}
              </ins>
            );
          }
          return (
            <span className="diff-eq" key={index}>
              {segment.text}
            </span>
          );
        })}
        {diff.segments.length > segments.length ? <span className="diff-more">（差异过长，已截断显示）</span> : null}
      </div>
    </div>
  );
}
