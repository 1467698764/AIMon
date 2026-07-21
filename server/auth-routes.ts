import { Router } from 'express'
import { z } from 'zod'
import { authStatus, changePassword, login, logout, requireAppAuth, setupPassword } from './auth.js'

const router = Router()
const passwordInput = z.object({ password: z.string().min(1).max(200) })

router.get('/status', (request, response) => response.json(authStatus(request)))
router.post('/setup', (request, response) => {
  const { password } = passwordInput.parse(request.body)
  setupPassword(request, response, password)
  response.json({ ok: true })
})
router.post('/login', (request, response) => {
  const { password } = passwordInput.parse(request.body)
  login(request, response, password)
  response.json({ ok: true })
})
router.post('/logout', (request, response) => {
  logout(request, response)
  response.status(204).end()
})
router.post('/password', requireAppAuth, (request, response) => {
  const input = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  }).parse(request.body)
  changePassword(request, response, input.currentPassword, input.newPassword)
  response.json({ ok: true })
})

export default router
