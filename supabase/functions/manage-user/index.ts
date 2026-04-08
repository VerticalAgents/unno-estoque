import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify the caller is authenticated
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, erro: 'Não autenticado' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Create client with the caller's JWT to verify identity
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    // Get caller's profile to check if admin
    const { data: { user: caller } } = await userClient.auth.getUser()
    if (!caller) {
      return new Response(JSON.stringify({ ok: false, erro: 'Sessão inválida' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { data: callerProfile } = await userClient
      .from('usuarios')
      .select('papel, empresa_id')
      .eq('id', caller.id)
      .single()

    if (!callerProfile || callerProfile.papel !== 'admin') {
      return new Response(JSON.stringify({ ok: false, erro: 'Apenas administradores podem gerenciar usuários' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Admin client with service role key
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const body = await req.json()
    const { action } = body

    if (action === 'create') {
      const { email, password, nome, papel } = body

      if (!email || !password || !nome) {
        return new Response(JSON.stringify({ ok: false, erro: 'Email, senha e nome são obrigatórios' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Create auth user
      const { data: newUser, error: authError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })

      if (authError) {
        return new Response(JSON.stringify({ ok: false, erro: authError.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Insert into usuarios table with same empresa_id as the admin
      const { error: dbError } = await adminClient.from('usuarios').insert({
        id: newUser.user.id,
        empresa_id: callerProfile.empresa_id,
        nome,
        email,
        papel: papel || 'producao',
        ativo: true,
      })

      if (dbError) {
        // Rollback: delete auth user if DB insert fails
        await adminClient.auth.admin.deleteUser(newUser.user.id)
        return new Response(JSON.stringify({ ok: false, erro: dbError.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true, userId: newUser.user.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'reset-password') {
      const { userId, password } = body

      if (!userId || !password) {
        return new Response(JSON.stringify({ ok: false, erro: 'userId e password são obrigatórios' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Verify the target user belongs to the same company
      const { data: targetUser } = await adminClient
        .from('usuarios')
        .select('empresa_id')
        .eq('id', userId)
        .single()

      if (!targetUser || targetUser.empresa_id !== callerProfile.empresa_id) {
        return new Response(JSON.stringify({ ok: false, erro: 'Usuário não encontrado na sua empresa' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { error } = await adminClient.auth.admin.updateUserById(userId, { password })

      if (error) {
        return new Response(JSON.stringify({ ok: false, erro: error.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ ok: false, erro: 'Ação inválida' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, erro: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
