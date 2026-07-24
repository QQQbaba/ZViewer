import { useLocation } from 'react-router-dom'
import { useThemeStore } from '@/store/themeStore'
import { Header } from './Header'

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const {
    backgroundImage,
    backgroundBlur,
    backgroundOpacity,
    backgroundPositionX,
    backgroundPositionY,
    backgroundScale,
    backgroundRotate,
    reducedMotion,
  } = useThemeStore()

  const hasCustomBackground = !!backgroundImage

  return (
    <div
      className="relative flex min-h-screen flex-col"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      style={{
        // 有自定义背景时容器透明，由 body 的 surface 色作为底色（深色模式下为暗色），
        // 透明度降低时透出的是 surface 色而非白色
        backgroundColor: hasCustomBackground
          ? 'transparent'
          : 'var(--md-sys-color-surface)',
        backgroundImage: hasCustomBackground
          ? 'none'
          : 'radial-gradient(circle at 10% 20%, color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent) 0%, transparent 40%), radial-gradient(circle at 90% 80%, color-mix(in srgb, var(--md-sys-color-tertiary) 6%, transparent) 0%, transparent 40%)',
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      {/* 背景图片层：自定义背景或默认背景图，浅色/深色模式均显示 */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          zIndex: 0,
          backgroundImage: `url(${backgroundImage || '/Nacho3.jpg'})`,
          backgroundSize: 'cover',
          // 位置固定居中，偏移由 transform: translate 控制
          // （background-position 百分比在 cover 下当某方向无溢出时完全无效）
          backgroundPosition: 'center',
          filter: `blur(${backgroundBlur}px)`,
          opacity: backgroundImage
            ? backgroundOpacity
            : Math.min(backgroundOpacity, 0.85),
          // translate 在 scale/rotate 之前，避免缩放中心扩张吃掉偏移
          // 百分比除以 2 限制最大偏移为 ±50%，防止图片完全移出视口
          transform: `translate(${backgroundPositionX / 2}%, ${backgroundPositionY / 2}%) scale(${backgroundScale}) rotate(${backgroundRotate}deg)`,
        }}
      />

      {/* 内容层：提升 z-index，确保位于背景图之上 */}
      <div className="relative z-10 flex flex-1 flex-col">
        <Header />
        <main
          key={location.pathname}
          className="flex flex-1 flex-col zen-page-enter"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
