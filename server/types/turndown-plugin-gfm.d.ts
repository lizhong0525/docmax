// turndown-plugin-gfm 没有自带类型声明，这里做最小声明。
declare module 'turndown-plugin-gfm' {
  type Plugin = (service: unknown) => void;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
}
