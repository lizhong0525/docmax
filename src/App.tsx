/**
 * DocMax 界面入口。
 *
 * 结构：
 *   顶栏（品牌 / 状态 / 文件与视图操作）
 *   ├─ 编辑区（标题 + 稿件纸面 + 选区状态栏）
 *   └─ 审阅栏（流式生成 / 差异 / 接受或拒绝）
 *   指令条（底部固定）
 *
 * 主链路：选中文字 → Ctrl/⌘+K → 指令 → 流式审阅 → 接受（单个 transaction，
 * 一次 Ctrl+Z 可回滚）或拒绝（文档不变）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchHealth } from './core/client';
import { applyProposals } from './core/apply';
import { analyzeSelection, buildRangeSnapshot } from './core/selection';
import { DEFAULT_LIMITS } from './core/protocol';
import { getPromptPreset, type PromptPresetId } from './core/presets';
import type { DocDetail, DocSummary, RevisionSource } from './core/docs';
import type { EditProposal, ModelId, ThinkingLevel } from './core/types';
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from './ui/CodeMirrorEditor';
import { SelectionStatus } from './ui/SelectionStatus';
import { CommandBar } from './ui/CommandBar';
import { ReviewPanel } from './ui/ReviewPanel';
import { MarkdownPreview } from './ui/Preview';
import { HelpOverlay } from './ui/HelpOverlay';
import { useEditSession, type SessionContext } from './ui/useEditSession';
import { docApi } from './ui/docApi';
import { DocumentLibrary } from './ui/DocumentLibrary';
import { HistoryPanel } from './ui/HistoryPanel';
import { IconBraces, IconClose, IconEdit, IconFolder, IconHelp, IconMoon, IconPreview, IconSave, IconSparkle, IconSun, IconWord } from './ui/Icons';
import { DocxImportDialog, type DocxImportState } from './ui/DocxImportDialog';
import { importDocx, pickDocxFile } from './ui/docxImport';
import type {
  DraftContext,
  DraftRange,
  EditorSelectionInfo,
  HealthState,
  ModeChoice,
  RunParams,
  ThemeMode,
} from './ui/types';
import {
  docStats,
  fileNameFor,
  formatClock,
  initialDocument,
  isEditableTarget,
  loadActiveDocId,
  loadPrefs,
  loadTheme,
  oneLine,
  storeActiveDocId,
  storeDoc,
  storePrefs,
  storeTheme,
} from './ui/utils';
import { openMarkdownFile, saveMarkdownFile, type FsFileHandle } from './ui/fileIO';

type PaneMode = 'edit' | 'preview';

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

/** 提案与当前文档是否仍然匹配（过期检测） */
function checkStale(docText: string, proposals: EditProposal[]): { stale: boolean; reason: string | null } {
  if (!proposals.length) return { stale: false, reason: null };
  const result = applyProposals(docText, proposals);
  if (result.ok) return { stale: false, reason: null };
  return { stale: true, reason: result.error ?? '文档在生成期间发生变化，修改位置可能已错位。' };
}

export function App() {
  const [initial] = useState(() => initialDocument());
  const [title, setTitle] = useState(initial.title);
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme() ?? (prefersDark() ? 'dark' : 'light'));
  const [paneMode, setPaneMode] = useState<PaneMode>('edit');
  const [selection, setSelection] = useState<EditorSelectionInfo | null>(null);
  const [stableDoc, setStableDoc] = useState(initial.text);
  const [docEpoch, setDocEpoch] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [fileHandle, setFileHandle] = useState<FsFileHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [draft, setDraft] = useState<DraftContext | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [health, setHealth] = useState<HealthState>('checking');
  const [docxImport, setDocxImport] = useState<DocxImportState | null>(null);
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [staleOverride, setStaleOverride] = useState<string | null>(null);

  /* 文档库 / 留痕 */
  const [docList, setDocList] = useState<DocSummary[]>([]);
  const [docsRoot, setDocsRoot] = useState('');
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [docsLoading, setDocsLoading] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<'local' | 'saving' | 'synced' | 'error'>('local');
  const [revisionCount, setRevisionCount] = useState(0);

  const [prefs, setPrefs] = useState<{
    model: ModelId;
    thinking: ThinkingLevel;
    modeChoice: ModeChoice;
    presetId: PromptPresetId;
  }>(() => {
    const stored = loadPrefs();
    return {
      model: stored.model ?? 'deepseek-flash',
      thinking: stored.thinking ?? 'off',
      modeChoice: 'auto',
      presetId: getPromptPreset(stored.presetId).id,
    };
  });

  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
  const docRef = useRef(initial.text);
  const docRevRef = useRef(0);
  const titleRef = useRef(initial.title);
  const lastParamsRef = useRef<RunParams | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const docxFileRef = useRef<File | null>(null);
  const activeDocIdRef = useRef<string | null>(null);
  const lastSavedRef = useRef<{ content: string; title: string } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const persistDocRef = useRef<(source: RevisionSource, extra?: { detail?: Record<string, unknown>; note?: string; force?: boolean }) => Promise<void>>(
    async () => undefined,
  );
  const bootstrappedRef = useRef(false);
  const proposalLoggedRef = useRef<string | null>(null);
  const session = useEditSession();
  const sessionState = session.state;

  const isMac = useMemo(isMacPlatform, []);
  const stats = useMemo(() => docStats(stableDoc), [stableDoc]);
  const docLines = useMemo(() => (stableDoc ? stableDoc.split('\n').length : 0), [stableDoc]);

  /* ------------------------------ 基础副作用 ------------------------------ */

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    storeTheme(theme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setTimeout(() => setStableDoc(docRef.current), 220);
    return () => window.clearTimeout(timer);
  }, [docEpoch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      storeDoc({ title: titleRef.current, text: docRef.current, updatedAt: Date.now() });
      setSavedAt(Date.now());
    }, 600);
    return () => window.clearTimeout(timer);
  }, [docEpoch, title]);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchHealth()
        .then((data) => {
          if (!cancelled) setHealth(data.hasApiKey ? 'ok' : 'nokey');
        })
        .catch(() => {
          if (!cancelled) setHealth('offline');
        });
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 新一轮生成 / 关闭审阅时，清空二次确认与过期覆盖状态
  useEffect(() => {
    setConfirmAccept(false);
    setStaleOverride(null);
  }, [sessionState.startedAt, sessionState.status]);

  const showToast = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  /* ------------------------------- 文档库 / 留痕 ------------------------------ */

  const refreshDocs = async (): Promise<DocSummary[]> => {
    try {
      const data = await docApi.list();
      setDocList(data.docs);
      setDocsRoot(data.root);
      setDocsError(null);
      return data.docs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDocsError(message);
      return [];
    }
  };

  const applyDocContent = (doc: DocDetail): void => {
    activeDocIdRef.current = doc.id;
    docRef.current = doc.content;
    titleRef.current = doc.title;
    lastSavedRef.current = { content: doc.content, title: doc.title };
    setActiveDocId(doc.id);
    storeActiveDocId(doc.id);
    setTitle(doc.title);
    setStableDoc(doc.content);
    docRevRef.current += 1;
    setDocEpoch((epoch) => epoch + 1);
    editorRef.current?.resetDoc(doc.content, 0);
    setSelection(null);
    session.reset();
    setPaneMode('edit');
    setSyncState('synced');
    setRevisionCount(doc.revisionCount);
    setSavedAt(new Date(doc.updatedAt).getTime());
    storeDoc({ title: doc.title, text: doc.content, updatedAt: Date.now() });
  };

  const persistDoc = async (
    source: RevisionSource,
    extra?: { detail?: Record<string, unknown>; note?: string; force?: boolean },
  ): Promise<void> => {
    const id = activeDocIdRef.current;
    if (!id) return;
    const content = docRef.current;
    const title = titleRef.current;
    const last = lastSavedRef.current;
    if (!extra?.force && last && last.content === content && last.title === title) return;
    if (saveInFlightRef.current) {
      pendingSaveRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    setSyncState('saving');
    try {
      const result = await docApi.save(id, {
        content,
        title,
        source,
        note: extra?.note,
        detail: extra?.detail,
      });
      if (activeDocIdRef.current === id) lastSavedRef.current = { content, title };
      setSyncState('synced');
      setSavedAt(Date.now());
      setRevisionCount(result.doc.revisionCount);
      setDocList((previous) => {
        if (!previous.some((entry) => entry.id === result.doc.id)) return previous;
        return previous
          .map((entry) => (entry.id === result.doc.id ? result.doc : entry))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      setHistoryRefreshKey((key) => key + 1);
    } catch (error) {
      setSyncState('error');
      if (source !== 'auto-save') showToast(`文档库保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      saveInFlightRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        window.setTimeout(() => {
          void persistDocRef.current('auto-save');
        }, 0);
      }
    }
  };
  persistDocRef.current = persistDoc;

  const flushSave = async (source: RevisionSource = 'manual-save'): Promise<void> => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await persistDoc(source);
  };

  const openDocById = async (id: string, options?: { silent?: boolean }): Promise<void> => {
    try {
      setDocsLoading(true);
      await flushSave();
      const { doc } = await docApi.get(id);
      applyDocContent(doc);
      await refreshDocs();
      setLibraryOpen(false);
      setHistoryRefreshKey((key) => key + 1);
      void docApi.audit(id, { type: 'doc-opened', summary: '打开文档' }).catch(() => undefined);
      if (!options?.silent) showToast(`已打开「${oneLine(doc.title, 24)}」`);
    } catch (error) {
      showToast(`打开文档失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDocsLoading(false);
    }
  };

  const createNewDocument = async (title?: string): Promise<void> => {
    try {
      await flushSave();
      const finalTitle = (title ?? '').trim() || `未命名文档 ${formatClock(Date.now())}`;
      const created = await docApi.create({ title: finalTitle, content: '' });
      applyDocContent(created.doc);
      await refreshDocs();
      setLibraryOpen(false);
      setHistoryRefreshKey((key) => key + 1);
      showToast(`已新建「${finalTitle}」`);
    } catch (error) {
      showToast(`新建文档失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };

  const renameDocument = async (id: string, title: string): Promise<void> => {
    const result = await docApi.rename(id, title);
    if (activeDocIdRef.current === id) {
      titleRef.current = result.doc.title;
      setTitle(result.doc.title);
      lastSavedRef.current = { content: docRef.current, title: result.doc.title };
    }
    setDocList((previous) => previous.map((entry) => (entry.id === id ? result.doc : entry)));
    setHistoryRefreshKey((key) => key + 1);
    showToast('标题已更新，并写入留痕');
  };

  const deleteDocument = async (id: string): Promise<void> => {
    await flushSave();
    await docApi.remove(id);
    if (activeDocIdRef.current === id) {
      activeDocIdRef.current = null;
      setActiveDocId(null);
      storeActiveDocId(null);
    }
    const remaining = await refreshDocs();
    showToast('文档已移入 trash 回收站（留痕与版本保留）');
    if (!activeDocIdRef.current) {
      if (remaining[0]) await openDocById(remaining[0].id, { silent: true });
      else await createNewDocument('未命名文档');
    }
  };

  const revealDocument = async (id: string): Promise<void> => {
    const result = await docApi.reveal(id);
    showToast(`已在资源管理器打开：${result.folder}`);
  };

  const restoreDocumentContent = (content: string, rev: number): void => {
    docRef.current = content;
    lastSavedRef.current = { content, title: titleRef.current };
    editorRef.current?.resetDoc(content, 0);
    setStableDoc(content);
    setDocEpoch((epoch) => epoch + 1);
    setSelection(null);
    setSyncState('synced');
    setRevisionCount(rev);
    setHistoryRefreshKey((key) => key + 1);
    void refreshDocs();
    showToast(`已回滚到 v${rev}，当前内容已作为新版本保留`);
  };

  /* 首次加载：取文档列表；一个文档都没有时把本地草稿落成第一个文档 */
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void (async () => {
      setDocsLoading(true);
      try {
        const data = await docApi.list();
        setDocList(data.docs);
        setDocsRoot(data.root);
        setDocsError(null);
        let id = loadActiveDocId();
        if (!id || !data.docs.some((doc) => doc.id === id)) id = data.docs[0]?.id ?? null;
        if (!id) {
          const created = await docApi.create({ title: titleRef.current || '未命名文档', content: docRef.current });
          id = created.doc.id;
          setDocList([created.doc]);
        }
        const { doc } = await docApi.get(id);
        applyDocContent(doc);
        void docApi.audit(id, { type: 'doc-opened', summary: '打开文档' }).catch(() => undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setDocsError(message);
        setSyncState('error');
        setDocsLoading(false);
      } finally {
        setDocsLoading(false);
        setBootstrapping(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 自动保存到文档库（1200ms 防抖，产生版本与留痕） */
  useEffect(() => {
    if (!activeDocIdRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistDocRef.current('auto-save');
    }, 1200);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [docEpoch, title]);

  /* AI 提案一出现就留痕（无论最终接受还是拒绝） */
  useEffect(() => {
    const proposal = sessionState.proposals[0];
    const id = activeDocIdRef.current;
    if (!proposal || !id) return;
    const key = `${proposal.requestId}:${proposal.ops.map((op) => `${op.from}-${op.to}`).join(',')}`;
    if (proposalLoggedRef.current === key) return;
    proposalLoggedRef.current = key;
    const allOps = sessionState.proposals.flatMap((item) => item.ops);
    const detail = {
      instruction: sessionState.instruction,
      model: sessionState.model,
      presetId: sessionState.presetId,
      requestId: proposal.requestId,
      mode: proposal.mode,
      before: allOps.map((op) => op.oldText).join('\n\n'),
      after: allOps.map((op) => op.newText).join('\n\n'),
      warnings: sessionState.proposals.flatMap((item) => item.warnings.map((warning) => warning.code)),
    };
    void docApi
      .audit(id, {
        type: 'ai-proposal',
        summary: `AI 提案：${oneLine(sessionState.instruction || '（空指令）', 40)}`,
        detail,
      })
      .catch(() => undefined);
    setHistoryRefreshKey((key) => key + 1);
  }, [sessionState.proposals, sessionState.instruction, sessionState.model, sessionState.presetId]);


  /* -------------------------------- 编辑器 -------------------------------- */

  const handleDocChange = useCallback((text: string) => {
    docRef.current = text;
    docRevRef.current += 1;
    setDocEpoch((epoch) => epoch + 1);
  }, []);

  const handleSelection = useCallback((info: EditorSelectionInfo) => {
    setSelection(info);
  }, []);

  /* ------------------------------- 命令条 --------------------------------- */

  const openCommandBar = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.isComposing()) return;
    if (sessionState.status === 'running') {
      showToast('正在生成，请稍候或按 Esc 中止');
      return;
    }
    const doc = editor.getDoc();
    const ranges = editor.getRanges();
    if (!ranges.length) return;
    const draftRanges: DraftRange[] = ranges.map((range, index) => {
      const snapshot = buildRangeSnapshot(doc, range, index, DEFAULT_LIMITS.defaultContextChars);
      const analysis = analyzeSelection(doc, range.from, range.to, index);
      return { ...range, index, analysis, snapshot };
    });
    setDraft({
      ranges: draftRanges,
      docChars: doc.length,
      docLines: doc ? doc.split('\n').length : 0,
      docTitle: titleRef.current,
    });
    setDetailOpen(false);
    setCommandOpen(true);
  }, [sessionState.status, showToast]);

  const closeCommandBar = useCallback(() => {
    setCommandOpen(false);
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const buildContext = (): SessionContext | null => {
    const editor = editorRef.current;
    if (!editor) return null;
    const ranges = editor.getRanges();
    if (!ranges.length) return null;
    return {
      docText: docRef.current,
      docTitle: titleRef.current,
      docRev: docRevRef.current,
      ranges,
    };
  };

  const startFromParams = (params: RunParams) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.isComposing()) {
      showToast('输入法正在输入，完成后再试');
      return;
    }
    const context = buildContext();
    if (!context) return;
    lastParamsRef.current = params;
    setPrefs({ model: params.model, thinking: params.thinking, modeChoice: params.modeChoice, presetId: params.presetId });
    storePrefs({ model: params.model, thinking: params.thinking, presetId: params.presetId });
    session.start(params, context);
  };

  const handleCommandSubmit = (params: RunParams) => {
    setCommandOpen(false);
    setConfirmAccept(false);
    setStaleOverride(null);
    startFromParams(params);
  };

  /* ------------------------------ 接受 / 拒绝 ------------------------------ */

  const logAiRejected = (summary: string, reason?: string): void => {
    const proposal = sessionState.proposals[0];
    const id = activeDocIdRef.current;
    if (!proposal || !id) return;
    const allOps = sessionState.proposals.flatMap((item) => item.ops);
    void docApi
      .audit(id, {
        type: 'ai-rejected',
        summary,
        detail: {
          instruction: sessionState.instruction,
          model: sessionState.model,
          presetId: sessionState.presetId,
          mode: proposal.mode,
          requestId: proposal.requestId,
          reason,
          before: allOps.map((op) => op.oldText).join('\n\n'),
          after: allOps.map((op) => op.newText).join('\n\n'),
        },
      })
      .catch(() => undefined);
    setHistoryRefreshKey((key) => key + 1);
  };

  const reject = () => {
    logAiRejected('拒绝 AI 提案', '用户点击拒绝');
    session.reset();
    setConfirmAccept(false);
    showToast('已拒绝，文档未修改（已写入留痕）');
    editorRef.current?.focus();
  };

  const closeSession = () => {
    const wasActive = sessionState.status !== 'idle';
    if (sessionState.status === 'review' && sessionState.proposals.length > 0) {
      logAiRejected('关闭审阅，未应用 AI 提案', '用户关闭审阅面板');
    }
    session.reset();
    setConfirmAccept(false);
    if (wasActive) window.requestAnimationFrame(() => editorRef.current?.focus());
  };

  const accept = () => {
    const state = sessionState;
    const editor = editorRef.current;
    if (!editor || state.status === 'running') return;
    if (editor.isComposing()) {
      showToast('输入法正在输入，完成后再接受');
      return;
    }
    const ops = state.proposals.flatMap((proposal) => proposal.ops);
    if (!ops.length) {
      showToast(state.ask ? '解释模式不会修改文档' : '没有可应用的修改');
      return;
    }
    if (ops.every((op) => op.newText === op.oldText)) {
      showToast('模型认为无需修改');
      return;
    }
    const hasErrorWarning = state.proposals.some(
      (proposal) => proposal.truncated || proposal.warnings.some((warning) => warning.severity === 'error'),
    );
    if (hasErrorWarning && !confirmAccept) {
      setConfirmAccept(true);
      showToast('存在风险警告：请核对差异后再次点击「确认接受」');
      return;
    }

    const doc = editor.getDoc();
    const validation = applyProposals(doc, state.proposals);
    if (!validation.ok) {
      const reason = validation.error ?? '文档已变化，请重新生成。';
      setStaleOverride(reason);
      showToast(reason);
      return;
    }

    const orderedOps = [...ops].sort((a, b) => a.from - b.from);
    const changes = orderedOps.map((op) => ({ from: op.from, to: op.to, insert: op.newText }));
    const cursor = orderedOps.reduce((max, op) => Math.max(max, op.from + op.newText.length), 0);
    const applied = editor.applyChanges(changes, cursor);
    if (!applied) {
      showToast('应用修改失败，请重试');
      return;
    }
    const appliedDoc = editor.getDoc();
    docRef.current = appliedDoc;
    const allOps = state.proposals.flatMap((proposal) => proposal.ops);
    void persistDoc('ai-accept', {
      note: 'AI 修订已接受',
      detail: {
        instruction: state.instruction,
        model: state.model,
        presetId: state.presetId,
        requestId: state.proposals[0]?.requestId,
        mode: state.proposals[0]?.mode,
        before: allOps.map((op) => op.oldText).join('\n\n'),
        after: allOps.map((op) => op.newText).join('\n\n'),
        warnings: state.proposals.flatMap((proposal) => proposal.warnings.map((warning) => warning.code)),
      },
    });
    setHistoryRefreshKey((key) => key + 1);
    session.reset();
    setConfirmAccept(false);
    setStaleOverride(null);
    editor.focus();
    showToast(orderedOps.length > 1 ? `已应用 ${orderedOps.length} 处修改 · Ctrl+Z 可撤销` : '已应用修改 · Ctrl+Z 可撤销');
  };

  const retryParams = (): RunParams | null => {
    if (sessionState.instruction) {
      return {
        instruction: sessionState.instruction,
        model: sessionState.model,
        thinking: sessionState.thinking,
        modeChoice: sessionState.modeChoice,
        ask: sessionState.ask,
        presetId: sessionState.presetId,
      };
    }
    return lastParamsRef.current;
  };

  const retry = () => {
    const params = retryParams();
    if (params) startFromParams(params);
  };

  const regenerate = () => {
    const params = retryParams();
    if (params) startFromParams(params);
  };

  const abortSession = () => {
    session.abort();
    showToast('已取消生成');
  };

  /* ------------------------------- 文件操作 -------------------------------- */

  const openFile = async () => {
    try {
      const result = await openMarkdownFile();
      if (!result) return;
      try {
        await flushSave();
        const created = await docApi.create({ title: result.title || '导入的 Markdown 文件', content: result.text });
        applyDocContent(created.doc);
        await refreshDocs();
        void docApi
          .audit(created.doc.id, {
            type: 'markdown-imported',
            summary: '从本地 Markdown 文件创建文档',
            detail: { title: result.title, fileName: result.handle?.name, chars: result.text.length },
          })
          .catch(() => undefined);
        setHistoryRefreshKey((key) => key + 1);
        setFileHandle(result.handle);
        setFileName(result.handle ? result.handle.name : null);
        showToast(`已作为新文档打开「${oneLine(result.title, 24)}」`);
        return;
      } catch {
        // 文档库不可用时退回原来的本地文件编辑模式
      }
      docRef.current = result.text;
      docRevRef.current += 1;
      titleRef.current = result.title;
      setTitle(result.title);
      setStableDoc(result.text);
      setDocEpoch((epoch) => epoch + 1);
      setFileHandle(result.handle);
      setFileName(result.handle ? result.handle.name : null);
      setPaneMode('edit');
      setSelection(null);
      session.reset();
      editorRef.current?.resetDoc(result.text, 0);
      showToast(`已打开「${oneLine(result.title, 24)}」`);
    } catch (error) {
      showToast(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const saveFile = async (saveAs = false) => {
    try {
      const result = await saveMarkdownFile(fileHandle, fileNameFor(titleRef.current), docRef.current, { saveAs });
      if (!result) return;
      setFileHandle(result.handle);
      setFileName(result.fileName);
      showToast(result.downloaded ? `已下载「${result.fileName}」` : `已保存「${result.fileName}」`);
    } catch (error) {
      showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 保存到文档库（生成版本/留痕）；若绑定了本地文件或另存为，再写本地文件 */
  const saveCurrentDoc = async (saveAs = false): Promise<void> => {
    await flushSave('manual-save');
    if (fileHandle || saveAs) {
      await saveFile(saveAs);
      return;
    }
    showToast('已保存到文档库（生成新版本，留痕已更新）');
    setHistoryRefreshKey((key) => key + 1);
  };

  /* ----------------------------- Word 导入 ------------------------------ */

  const runDocxImport = async (file: File): Promise<void> => {
    docxFileRef.current = file;
    setDocxImport({ phase: 'converting', fileName: file.name, result: null, error: null });
    try {
      const result = await importDocx(file);
      setDocxImport({ phase: 'ready', fileName: file.name, result, error: null });
    } catch (error) {
      setDocxImport({
        phase: 'error',
        fileName: file.name,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const importWordFile = async (): Promise<void> => {
    if (sessionState.status === 'running') {
      showToast('正在生成，请稍候或按 Esc 中止');
      return;
    }
    try {
      const file = await pickDocxFile();
      if (!file) return;
      if (file.size > DEFAULT_LIMITS.maxDocxBytes) {
        setDocxImport({
          phase: 'error',
          fileName: file.name,
          result: null,
          error: `文件超过大小上限（${Math.round(DEFAULT_LIMITS.maxDocxBytes / 1024 / 1024)} MB）。`,
        });
        return;
      }
      await runDocxImport(file);
    } catch (error) {
      showToast(`选择文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const cancelDocxImport = (): void => {
    setDocxImport(null);
    docxFileRef.current = null;
    editorRef.current?.focus();
  };

  const retryDocxImport = (): void => {
    const file = docxFileRef.current;
    if (file) void runDocxImport(file);
  };

  const confirmDocxImport = (): void => {
    const state = docxImport;
    if (!state?.result) return;
    const text = state.result.markdown;
    const nextTitle = state.result.title || state.fileName.replace(/\.docx$/i, '') || '导入的文档';
    const apply = (): void => {
      docRef.current = text;
      docRevRef.current += 1;
      titleRef.current = nextTitle;
      setTitle(nextTitle);
      setStableDoc(text);
      setDocEpoch((epoch) => epoch + 1);
      setFileHandle(null);
      setFileName(null);
      setPaneMode('edit');
      setSelection(null);
      session.reset();
      editorRef.current?.resetDoc(text, 0);
      setDocxImport(null);
      docxFileRef.current = null;
      showToast(`已导入 Word 文档（${state.result?.stats.chars ?? text.length} 字），创建为新文档`);
    };
    void (async () => {
      try {
        await flushSave();
        const created = await docApi.create({ title: nextTitle, content: text });
        applyDocContent(created.doc);
        await refreshDocs();
        void docApi
          .audit(created.doc.id, {
            type: 'docx-imported',
            summary: `导入 Word：${state.fileName}`,
            detail: {
              fileName: state.fileName,
              stats: state.result?.stats,
              warnings: state.result?.warnings,
            },
          })
          .catch(() => undefined);
        setHistoryRefreshKey((key) => key + 1);
        setFileHandle(null);
        setFileName(null);
        setDocxImport(null);
        docxFileRef.current = null;
        showToast(`已导入 Word 文档（${state.result?.stats.chars ?? text.length} 字），创建为新文档`);
      } catch {
        apply();
      }
    })();
  };

  const togglePreview = () => {
    setPaneMode((current) => {
      const next: PaneMode = current === 'edit' ? 'preview' : 'edit';
      if (next === 'edit') {
        window.requestAnimationFrame(() => {
          editorRef.current?.requestMeasure();
          editorRef.current?.focus();
        });
      }
      return next;
    });
  };

  /* ------------------------------ 过期与接受判定 ----------------------------- */

  const staleInfo = useMemo(
    () => checkStale(stableDoc, sessionState.proposals),
    [stableDoc, sessionState.proposals],
  );
  const effectiveStale = staleOverride !== null || staleInfo.stale;
  const staleReason = staleOverride ?? staleInfo.reason;

  const gate = useMemo(() => {
    const ops = sessionState.proposals.flatMap((proposal) => proposal.ops);
    const isAsk = sessionState.ask;
    const noChange = ops.length > 0 && ops.every((op) => op.newText === op.oldText);
    const hasErrorWarning = sessionState.proposals.some(
      (proposal) => proposal.truncated || proposal.warnings.some((warning) => warning.severity === 'error'),
    );
    const canAccept =
      sessionState.status !== 'running' && !isAsk && ops.length > 0 && !noChange && !effectiveStale;
    let acceptLabel = '接受修改';
    if (noChange) acceptLabel = '无需修改';
    else if (hasErrorWarning) acceptLabel = confirmAccept ? '确认接受' : '接受（需确认）';
    return { ops, isAsk, noChange, hasErrorWarning, canAccept, acceptLabel };
  }, [sessionState, effectiveStale, confirmAccept]);

  /* ------------------------------- 全局快捷键 ------------------------------ */

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const activeElement = document.activeElement;

    if (mod && key === 'k') {
      event.preventDefault();
      if (commandOpen) {
        closeCommandBar();
      } else if (!editorRef.current?.isComposing()) {
        openCommandBar();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (libraryOpen) {
        event.preventDefault();
        setLibraryOpen(false);
        return;
      }
      if (historyOpen) {
        event.preventDefault();
        setHistoryOpen(false);
        return;
      }
      if (docxImport) {
        event.preventDefault();
        cancelDocxImport();
        return;
      }
      if (helpOpen) {
        event.preventDefault();
        setHelpOpen(false);
        return;
      }
      if (detailOpen) {
        event.preventDefault();
        setDetailOpen(false);
        return;
      }
      if (commandOpen) {
        event.preventDefault();
        closeCommandBar();
        return;
      }
      if (sessionState.status === 'running') {
        event.preventDefault();
        abortSession();
        return;
      }
      if (sessionState.status !== 'idle') {
        event.preventDefault();
        closeSession();
        return;
      }
      return;
    }

    if (mod && event.key === 'Enter') {
      if (commandOpen) return;
      if (gate.ops.length > 0 && !gate.isAsk) {
        event.preventDefault();
        accept();
      }
      return;
    }

    if (mod && key === 'o') {
      event.preventDefault();
      void openFile();
      return;
    }

    if (mod && key === 's') {
      event.preventDefault();
      void saveCurrentDoc(event.shiftKey);
      return;
    }

    if (mod && key === 'p') {
      event.preventDefault();
      togglePreview();
      return;
    }

    if (mod && key === '/') {
      event.preventDefault();
      setHelpOpen((open) => !open);
      return;
    }

    if (mod && key === 'z' && !isEditableTarget(activeElement)) {
      event.preventDefault();
      editorRef.current?.focus();
      if (event.shiftKey) editorRef.current?.redo();
      else editorRef.current?.undo();
      return;
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /* --------------------------------- 渲染 --------------------------------- */

  const floatButton = useMemo(() => {
    if (commandOpen || paneMode !== 'edit' || sessionState.status !== 'idle') return null;
    const primary = selection?.ranges[0];
    if (!selection || !primary || !selection.coords || primary.analysis.chars === 0) return null;
    const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight;
    const left = Math.min(Math.max(selection.coords.left, 88), Math.max(96, viewportWidth - 120));
    const top = Math.min(selection.coords.bottom + 10, viewportHeight - 120);
    return { left, top };
  }, [commandOpen, paneMode, sessionState.status, selection]);

  const healthLabel =
    health === 'ok'
      ? 'DeepSeek 就绪'
      : health === 'nokey'
        ? '未配置 API Key'
        : health === 'offline'
          ? '服务未连接'
          : '连接中…';

  const syncLabel =
    syncState === 'saving'
      ? '同步中…'
      : syncState === 'error'
        ? '文档库离线'
        : syncState === 'synced'
          ? savedAt
            ? `已同步 ${formatClock(savedAt)}`
            : '已同步到文档库'
          : '本地草稿';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" aria-label="DocMax">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <span className="brand-name">DocMax</span>
          <span className="brand-sub">Markdown · DeepSeek</span>
        </div>

        <div className="topbar-meta">
          <span className={`health health-${health}`} title="本地服务与 API Key 状态" data-testid="health">
            <span className="health-dot" aria-hidden="true" />
            {healthLabel}
          </span>
          <span className="meta-sep" aria-hidden="true">
            /
          </span>
          <span className="file-meta" data-testid="file-meta">
            <span data-testid="sync-status">{syncLabel}</span>
            {activeDocId ? ` · v${revisionCount} · 留痕已开启` : ''}
          </span>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              setLibraryOpen(true);
              void refreshDocs();
            }}
            aria-label="文档库"
            title="文档库：新建 / 打开 / 管理文档"
            data-testid="open-library"
          >
            <IconFolder />
            <span className="tool-label">文档</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => void createNewDocument()}
            aria-label="新建文档"
            title="新建空白文档"
            data-testid="new-document"
          >
            <IconSparkle />
            <span className="tool-label">新建</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              setHistoryOpen(true);
              setHistoryRefreshKey((key) => key + 1);
            }}
            aria-label="审阅与留痕"
            title="审阅 / 留痕：AI 提案、版本、回滚"
            data-testid="open-history"
          >
            <IconBraces />
            <span className="tool-label">审阅</span>
          </button>
          <button type="button" className="tool-btn" onClick={openFile} aria-label="打开 Markdown 文件" title="打开 · Ctrl+O">
            <IconFolder />
            <span className="tool-label">打开</span>
          </button>
          <button
            type="button"
            className="tool-btn"
            onClick={() => void importWordFile()}
            aria-label="导入 Word 文档（.docx 转 Markdown）"
            title="导入 Word 文档（.docx → Markdown，图片占位）"
            data-testid="import-docx"
          >
            <IconWord />
            <span className="tool-label">导入 Word</span>
          </button>
          <button type="button" className="tool-btn" onClick={() => void saveCurrentDoc(false)} aria-label="保存文档" title="保存 · Ctrl+S">
            <IconSave />
            <span className="tool-label">保存</span>
          </button>
          <button
            type="button"
            className={`tool-btn${paneMode === 'preview' ? ' is-active' : ''}`}
            onClick={togglePreview}
            aria-pressed={paneMode === 'preview'}
            aria-label={paneMode === 'preview' ? '返回编辑' : '预览文档'}
            title="预览 · Ctrl+P"
            data-testid="toggle-preview"
          >
            {paneMode === 'preview' ? <IconEdit /> : <IconPreview />}
            <span className="tool-label">{paneMode === 'preview' ? '编辑' : '预览'}</span>
          </button>
          <button
            type="button"
            className="tool-btn tool-btn-icon"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title="切换主题"
            data-testid="toggle-theme"
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            className="tool-btn tool-btn-icon"
            onClick={() => setHelpOpen(true)}
            aria-label="查看快捷键帮助"
            title="快捷键 · Ctrl+/"
          >
            <IconHelp />
          </button>
        </div>
      </header>

      <div className="workspace">
        <main className="editor-pane" aria-label="编辑器">
          <div className="doc-head">
            <input
              className="doc-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  editorRef.current?.focus();
                }
              }}
              aria-label="文档标题"
              placeholder="未命名文档"
              data-testid="doc-title"
            />
            <div className="doc-meta">
              <span>
                {stats.chars.toLocaleString('zh-CN')} 字 · {docLines} 行
              </span>
              <span className="meta-sep" aria-hidden="true">
                /
              </span>
              <span data-testid="doc-sync">
                {activeDocId ? `v${revisionCount} · ${syncLabel}` : syncLabel}
              </span>
              {fileName ? (
                <>
                  <span className="meta-sep" aria-hidden="true">
                    /
                  </span>
                  <span className="doc-file">{oneLine(fileName, 40)}</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="paper" data-testid="paper">
            <div className={`editor-visible${paneMode === 'preview' ? ' is-hidden' : ''}`}>
              <CodeMirrorEditor
                ref={editorRef}
                dark={theme === 'dark'}
                initialDoc={initial.text}
                onChange={handleDocChange}
                onSelection={handleSelection}
                placeholder="从这里开始写。选中一段文字，按 Ctrl+K 让 DeepSeek 修改。"
              />
            </div>
            {paneMode === 'preview' ? (
              <div className="preview-scroll" data-testid="preview-pane">
                <MarkdownPreview docText={stableDoc} />
              </div>
            ) : null}
          </div>

          {paneMode === 'edit' ? (
            <SelectionStatus
              selection={selection}
              docText={stableDoc}
              docStats={stats}
              busy={sessionState.status === 'running'}
              detailOpen={detailOpen}
              isMac={isMac}
              onToggleDetail={() => setDetailOpen((open) => !open)}
              onOpenCommand={openCommandBar}
              onExpand={(unit) => editorRef.current?.expandSelection(unit)}
            />
          ) : (
            <footer className="statusbar statusbar-preview">
              <div className="status-left">
                <span className="status-muted">预览模式</span>
                <span className="status-sep" aria-hidden="true">
                  /
                </span>
                <span>
                  全文 {stats.chars.toLocaleString('zh-CN')} 字 · {docLines} 行
                </span>
              </div>
              <div className="status-right">
                <button
                  type="button"
                  className="status-btn"
                  onClick={togglePreview}
                  aria-label="返回编辑模式"
                  data-testid="back-to-edit"
                >
                  返回编辑
                </button>
              </div>
            </footer>
          )}
        </main>

        {sessionState.status !== 'idle' ? (
          <ReviewPanel
            state={sessionState}
            stale={effectiveStale}
            staleReason={staleReason}
            canAccept={gate.canAccept}
            acceptLabel={gate.acceptLabel}
            requiresConfirm={gate.hasErrorWarning && !confirmAccept}
            noChange={gate.noChange}
            isAsk={gate.isAsk}
            onClose={closeSession}
            onAbort={abortSession}
            onReject={reject}
            onAccept={accept}
            onRetry={retry}
            onRegenerate={regenerate}
          />
        ) : null}
      </div>

      {floatButton ? (
        <button
          type="button"
          className="ai-float"
          style={{ left: floatButton.left, top: floatButton.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openCommandBar}
          aria-label="让 AI 修改选中文字"
          data-testid="float-ai"
        >
          <span className="ai-trigger-glyph" aria-hidden="true">
            ✦
          </span>
          AI 修改
        </button>
      ) : null}

      <CommandBar
        open={commandOpen}
        draft={draft}
        busy={sessionState.status === 'running'}
        hasApiKey={health === 'ok' || health === 'checking'}
        serviceState={health}
        defaults={prefs}
        limits={DEFAULT_LIMITS}
        isMac={isMac}
        onClose={closeCommandBar}
        onSubmit={handleCommandSubmit}
      />

      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} isMac={isMac} />

      <DocumentLibrary
        open={libraryOpen}
        docs={docList}
        activeDocId={activeDocId}
        root={docsRoot}
        loading={docsLoading}
        error={docsError}
        onClose={() => setLibraryOpen(false)}
        onCreate={createNewDocument}
        onOpen={openDocById}
        onRename={renameDocument}
        onDelete={deleteDocument}
        onReveal={revealDocument}
        onRefresh={async () => {
          await refreshDocs();
        }}
      />

      <HistoryPanel
        open={historyOpen}
        docId={activeDocId}
        docTitle={title}
        refreshKey={historyRefreshKey}
        onClose={() => setHistoryOpen(false)}
        onRestored={restoreDocumentContent}
      />

      {docxImport ? (
        <DocxImportDialog
          state={docxImport}
          maxBytes={DEFAULT_LIMITS.maxDocxBytes}
          hasExistingDoc={stableDoc.trim().length > 0}
          onCancel={cancelDocxImport}
          onConfirm={confirmDocxImport}
          onRetry={retryDocxImport}
        />
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite" data-testid="toast" key={toast.id}>
          {toast.text}
        </div>
      ) : null}

      {detailOpen ? (
        <button
          type="button"
          className="detail-scrim"
          aria-label="关闭识别详情"
          onClick={() => setDetailOpen(false)}
          tabIndex={-1}
        />
      ) : null}

      <span className="sr-only" aria-live="polite">
        {sessionState.status === 'running'
          ? `正在生成第 ${sessionState.batch.current} 处修改`
          : sessionState.status === 'review'
            ? '修改已生成，等待审阅'
            : ''}
      </span>

      {bootstrapping ? (
        <div className="doc-boot" data-testid="doc-boot" role="status" aria-live="polite">
          <span className="doc-boot-mark" aria-hidden="true">
            ✦
          </span>
          <span>正在加载文档库…</span>
        </div>
      ) : null}

      {health === 'offline' ? (
        <div className="offline-banner" role="alert">
          <IconClose size={14} />
          本地服务未连接（/api/health）。请确认服务已在 5199 端口运行。
        </div>
      ) : null}
    </div>
  );
}
