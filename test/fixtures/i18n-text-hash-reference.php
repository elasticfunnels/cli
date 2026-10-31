<?php
// Reference PHP implementation of the translation source hash (spec: src/utils/textHash.ts).
// Regenerate the vectors: php test/fixtures/i18n-text-hash-reference.php <cases.json>
function visibleText(?string $html): string {
    $s = $html ?? '';
    $s = preg_replace('/<script\b[^>]*>[\s\S]*?<\/script\s*>/i', ' ', $s);
    $s = preg_replace('/<style\b[^>]*>[\s\S]*?<\/style\s*>/i', ' ', $s);
    $s = preg_replace('/<!--[\s\S]*?-->/', ' ', $s);
    $s = preg_replace('/<\/?[A-Za-z!?](?:[^>"\']|"[^"]*"|\'[^\']*\')*>/', ' ', $s);
    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = preg_replace('/\s+/u', ' ', $s);
    return trim($s, ' ');
}
function sourceHash(?string $t, ?string $d, ?string $html): string {
    return hash('sha256', ($t ?? '') . "\n" . ($d ?? '') . "\n" . visibleText($html));
}
$cases = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($cases as $c) {
    $c['visible_text'] = visibleText($c['html']);
    $c['hash'] = sourceHash($c['seo_title'], $c['seo_description'], $c['html']);
    $out[] = $c;
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
