$token = 'sbp_0cf1c648375625a565ca7dd06e7c064705386a01'
$url = 'https://api.supabase.com/v1/projects/outunfdtwgsmdqtphzgf/database/query'
$headers = @{ 'Authorization' = "Bearer $token" }

function Run-SQL($sql, $label) {
    try {
        $payload = [System.Text.Encoding]::UTF8.GetBytes(
            (ConvertTo-Json @{ query = $sql } -Depth 2 -Compress)
        )
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Method = 'POST'
        $req.ContentType = 'application/json; charset=utf-8'
        $req.Headers.Add('Authorization', "Bearer $token")
        $req.ContentLength = $payload.Length
        $stream = $req.GetRequestStream()
        $stream.Write($payload, 0, $payload.Length)
        $stream.Close()
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $result = $reader.ReadToEnd()
        Write-Host "OK: $label" -ForegroundColor Green
        return $true
    } catch [System.Net.WebException] {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        Write-Host "ERRO [$label]: $($body.Substring(0, [Math]::Min(400, $body.Length)))" -ForegroundColor Red
        return $false
    }
}

$migrations = @(
    "C:\Users\lucca\OneDrive\Área de Trabalho\IA\Projetos\MischaFlex\supabase\migrations\001_schema.sql",
    "C:\Users\lucca\OneDrive\Área de Trabalho\IA\Projetos\MischaFlex\supabase\migrations\002_rpc_transfer.sql",
    "C:\Users\lucca\OneDrive\Área de Trabalho\IA\Projetos\MischaFlex\supabase\migrations\003_rpc_fichas_tecnicas.sql"
)

foreach ($file in $migrations) {
    $name = Split-Path $file -Leaf
    $sql = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
    Write-Host "Aplicando $name ($($sql.Length) chars)..."
    Run-SQL $sql $name
}

Write-Host "`nVerificando tabelas criadas..."
Run-SQL "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" "check"
