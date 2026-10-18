/**
 * 极简线性图标（stroke = currentColor）。保持 16px 视觉重量，不引入图标库。
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconSparkle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
    </Icon>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5v-10z" />
    </Icon>
  );
}

export function IconSave(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4.5h11L19 7.5v12H5z" />
      <path d="M8 4.5v5h7v-5" />
      <path d="M8 19.5v-5h8v5" />
    </Icon>
  );
}

export function IconPreview(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </Icon>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20l4.5-1 9.9-9.9a2.1 2.1 0 0 0-3-3L5.5 16 4 20z" />
    </Icon>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
    </Icon>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
    </Icon>
  );
}

export function IconHelp(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2.9-1.2 1.8" />
      <path d="M12 17.2v.01" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function IconBraces(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4.5c-2 0-2.5 1-2.5 2.8v1.9c0 1.4-.7 2.3-2 2.8 1.3.5 2 1.4 2 2.8v1.9c0 1.8.5 2.8 2.5 2.8" />
      <path d="M15 4.5c2 0 2.5 1 2.5 2.8v1.9c0 1.4.7 2.3 2 2.8-1.3.5-2 1.4-2 2.8v1.9c0 1.8-.5 2.8-2.5 2.8" />
    </Icon>
  );
}

/** 导入 Word 文档：文档 + 向下箭头 */
export function IconWord(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5h8L18.5 8v12.5h-13z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9 12.5l1.4 4 1.6-2.6 1.6 2.6 1.4-4" />
    </Icon>
  );
}
