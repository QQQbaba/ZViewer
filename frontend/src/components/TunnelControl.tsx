import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Globe, Copy } from 'lucide-react'

/**
 * 公网邀请通道控制组件（主页/管理页通用）。
 * 与主页「开始共享」同款大按钮：点击即开/关，开启后展示邀请链接。
 */
export function TunnelControl() {
  const { isAuthenticated, user } = useAuthStore()
  const [running, setRunning] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const res = await apiFetch('/api/tunnel/status')
      const r = (await res.json()) as {
        success?: boolean
        running?: boolean
        url?: string | null
      }
      if (r.success) {
        setRunning(!!r.running)
        setUrl(r.url || '')
      }
    } catch {
      /* 忽略 */
    }
  }

  useEffect(() => {
    if (!isAuthenticated) return
    void refresh()
    const timer = setInterval(() => void refresh(), 10000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      const res = await apiFetch(on ? '/api/tunnel/start' : '/api/tunnel/stop', {
        method: 'POST',
      })
      const r = (await res.json()) as { success?: boolean; message?: string }
      if (r.success) {
        message.success(r.message ?? '操作成功')
        setRunning(on)
        if (!on) setUrl('')
      } else {
        message.error(r.message ?? '操作失败')
        setRunning(false)
      }
    } catch {
      message.error('通道操作失败')
      setRunning(false)
    }
    setBusy(false)
    void refresh()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      message.success('邀请链接已复制')
    } catch {
      message.success(url)
    }
  }

  if (!isAuthenticated || user?.role === 'guest') return null

  return (
    <div className="w-full">
      <Button
        variant={running ? 'primary' : 'secondary'}
        size="lg"
        block
        icon={<Globe className="h-5 w-5" />}
        loading={busy}
        disabled={busy}
        onClick={() => void toggle(!running)}
      >
        {running ? '公网邀请通道已开启' : '开启公网邀请通道'}
      </Button>
      {running && url && (
        <div className="mt-2 w-full">
          <div
            className="select-all break-all rounded-[var(--md-sys-shape-corner)] p-2.5 text-xs"
            style={{
              background: 'var(--md-sys-color-surface-variant)',
              color: 'var(--md-sys-color-primary)',
            }}
          >
            {url}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() => void copy()}
          >
            复制链接
          </Button>
        </div>
      )}
      {running && !url && (
        <Text type="secondary" className="mt-2 block text-center text-xs">
          通道建立中（约 10~30 秒）…
        </Text>
      )}
    </div>
  )
}