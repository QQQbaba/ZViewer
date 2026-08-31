import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'

export default function JoinByRoomIdPage() {
  const navigate = useNavigate()
  const [roomIdInput, setRoomIdInput] = useState('')
  const [joining, setJoining] = useState(false)
  const handleJoin = async () => {
    const trimmed = roomIdInput.trim()
    if (!trimmed) return
    setJoining(true)
    try {
      // v11.3：先查公告栏（房间号 → 房主最新地址），找到则跳到房主服务器
      try {
        const res = await fetch(`/api/directory/rooms/${encodeURIComponent(trimmed)}`)
        const data = await res.json().catch(() => null)
        if (data && data.success && data.room && data.room.url) {
          const base = String(data.room.url).replace(/\/$/, '')
          window.location.href = `${base}/room/${encodeURIComponent(trimmed)}`
          return
        }
      } catch {
        // 公告栏不可用时降级：同服务器直接加入
      }
      navigate(`/room/${trimmed}`)
    } finally {
      setJoining(false)
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="relative w-full max-w-md text-center">
        <PageBackButton to="/" />

        {/* 顶部留白，避免内容与返回按钮重叠 */}
        <div className="pt-8">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <LogIn className="h-6 w-6" />
          </div>
          <Title level={3} className="m-0">
            加入房间
          </Title>
          <Paragraph type="secondary" className="mt-2">
            输入房主分享的房间号
          </Paragraph>

          <div className="mt-6 flex w-full gap-2">
            <Input
              size="lg"
              placeholder="输入房间号"
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJoin()
              }}
              maxLength={64}
              autoFocus
            />
            <Button
              variant="secondary"
              size="lg"
              icon={<LogIn className="h-5 w-5 shrink-0" />}
              onClick={() => void handleJoin()}
              disabled={!roomIdInput.trim() || joining}
              loading={joining}
              className="shrink-0 whitespace-nowrap"
            >
              加入
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
