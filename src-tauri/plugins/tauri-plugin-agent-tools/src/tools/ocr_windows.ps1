$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Emit($o) { [Console]::Out.Write(($o | ConvertTo-Json -Depth 5 -Compress)) }
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

    $generic = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $action = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
    function Await($op, $type) { $t = $generic.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait() | Out-Null; $t.Result }
    function AwaitAction($op) { $t = $action.Invoke($null, @($op)); $t.Wait() | Out-Null }

    $path = $env:FLINT_OCR_PATH
    $kind = $env:FLINT_OCR_KIND
    $lang = $env:FLINT_OCR_LANG
    $want = @()
    if ($env:FLINT_OCR_PAGES) { $want = @($env:FLINT_OCR_PAGES.Split(',') | ForEach-Object { [int]$_ }) }
    $maxPages = [int]$env:FLINT_OCR_MAX_PAGES

    if ($lang) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($lang)))
    } else {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        Emit @{ error = 'no_engine'; detail = $(if ($lang) { "no OCR language pack for '$lang' is installed" } else { 'no OCR language pack is installed for the profile languages' }) }
        exit 0
    }
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension

    function Recognize($bitmap) {
        if ($bitmap.PixelWidth -gt $maxDim -or $bitmap.PixelHeight -gt $maxDim) {
            throw "the image is larger than the engine's $maxDim pixel limit"
        }
        (Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])).Text
    }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $pages = New-Object System.Collections.ArrayList
    $total = 1
    if ($kind -eq 'pdf') {
        $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
        $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
        $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
        $total = [int]$doc.PageCount
        $numbers = if ($want.Count -gt 0) { $want } else { 1..[Math]::Min($total, $maxPages) }
        foreach ($n in $numbers) {
            if ($n -lt 1 -or $n -gt $total) { throw "the PDF has $total page(s); page $n does not exist" }
            $page = $doc.GetPage($n - 1)
            $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $opts.DestinationWidth = [uint32][Math]::Min([Math]::Round($page.Size.Width * 3), $maxDim)
            $mem = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            AwaitAction ($page.RenderToStreamAsync($mem, $opts))
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($mem)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            [void]$pages.Add(@{ page = $n; text = (Recognize $bitmap) })
            $mem.Dispose()
        }
    } else {
        $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        [void]$pages.Add(@{ page = 1; text = (Recognize $bitmap) })
        $stream.Dispose()
    }
    Emit @{ engine = 'Windows.Media.Ocr'; total_pages = $total; pages = @($pages) }
} catch {
    Emit @{ error = 'failed'; detail = $_.Exception.Message }
}
