import { useEffect, useState } from 'react'
import { useAuthStore } from '@/store/authStore'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Tv, ExternalLink } from 'lucide-react'

/**
 * B 站大会员高画质代理控制组件。
 * 与主页「开始共享」同款大按钮：点击即开/关，开启后可打开配置页扫码登录。
 */
export function ZcliControl() {
  const { isAuthenticated, user } = useAuthStore()
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const res = await apiFetch('/api/zcli/status')
      const r = (await res.json()) as { success?: boolean; running?: boolean }
      if (r.success) setRunning(!!r.running)
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
      const res = await apiFetch(on ? '/api/zcli/start' : '/api/zcli/stop', {
        method: 'POST',
      })
      const r = (await res.json()) as { success?: boolean; message?: string }
      if (r.success) {
        message.success(r.message ?? '操作成功')
        setRunning(on)
      } else {
        message.error(r.message ?? '操作失败')
        setRunning(false)
      }
    } catch {
      message.error('代理操作失败')
      setRunning(false)
    }
    setBusy(false)
    void refresh()
  }

  const openConfig = () => {
    window.location.href = 'http://127.0.0.1:9333'
  }

  if (!isAuthenticated || user?.role === 'guest') return null

  return (
    <div className="w-full">
      <Button
        variant={running ? 'primary' : 'secondary'}
        size="lg"
        block
        icon={<Tv className="h-5 w-5" />}
        loading={busy}
        disabled={busy}
        onClick={() => void toggle(!running)}
      >
        {running ? 'B 站大会员代理已开启' : '开启 B 站大会员画质'}
      </Button>
      {running && (
        <div className="mt-2 w-full">
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            onClick={openConfig}
          >
            打开配置页（扫码登录）
          </Button>
          <Text type="secondary" className="mt-1 block text-center text-xs">
            配置完成后，房间内播放 B 站视频自动走本地代理解锁高画质
          </Text>
        </div>
      )}
    </div>
  )
}