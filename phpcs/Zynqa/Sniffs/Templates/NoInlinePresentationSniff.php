<?php

class Zynqa_Sniffs_Templates_NoInlinePresentationSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_INLINE_HTML];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (substr($fileName, -6) !== '.phtml') {
            return;
        }

        $content = $phpcsFile->getTokens()[$stackPtr]['content'];
        $checks = [
            '/<script\b/i' => 'Do not embed inline <script> blocks in .phtml templates; use RequireJS modules.',
            '/<style\b/i' => 'Do not embed inline <style> blocks in .phtml templates; use LESS/CSS assets.',
            '/\sstyle\s*=/i' => 'Do not use inline style attributes in .phtml templates.',
            '/\son[a-z]+\s*=/i' => 'Do not use inline DOM event handlers in .phtml templates.',
        ];

        foreach ($checks as $pattern => $message) {
            if (!preg_match($pattern, $content)) {
                continue;
            }

            $phpcsFile->addError($message, $stackPtr, 'InlinePresentation');
        }
    }
}
