$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$addresses = @(Get-NetIPAddress -ErrorAction Stop)
$result = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | ForEach-Object {
    $adapter = $_
    $identity = 'index:' + $adapter.ifIndex
    if ($adapter.InterfaceGuid) {
        $identity = 'windows:{' + $adapter.InterfaceGuid.ToString().Trim('{}').ToLower() + '}'
    }
    $rows = @($addresses | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex })
    if ($rows.Count -eq 0) { $rows = @($null) }
    foreach ($row in $rows) {
        [pscustomobject]@{
            id = $identity
            name = [string]$adapter.Name
            description = [string]$adapter.InterfaceDescription
            status = $adapter.Status.ToString()
            ip = $(if ($row) { [string]$row.IPAddress } else { '' })
            family = $(if ($row -and $row.AddressFamily -eq 'IPv6') { 6 } else { 4 })
            addressState = $(if ($row) { $row.AddressState.ToString() } else { '' })
        }
    }
})
ConvertTo-Json -InputObject $result -Depth 4 -Compress
