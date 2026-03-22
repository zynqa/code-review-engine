<?php

class Zynqa_Sniffs_Helpers_StatelessHelperSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_CLASS];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (strpos($fileName, '/Helper/') === false) {
            return;
        }

        $tokens = $phpcsFile->getTokens();
        $class = $tokens[$stackPtr];
        if (empty($class['scope_opener']) || empty($class['scope_closer'])) {
            return;
        }

        for ($ptr = $class['scope_opener'] + 1; $ptr < $class['scope_closer']; $ptr++) {
            if ($tokens[$ptr]['code'] !== T_VARIABLE) {
                continue;
            }

            $conditions = $tokens[$ptr]['conditions'] ?? [];
            if (!isset($conditions[$stackPtr])) {
                continue;
            }

            if ($this->isInsideFunctionScope($conditions)) {
                continue;
            }

            $phpcsFile->addError(
                'Helper classes must be stateless; move instance state out of helper classes.',
                $ptr,
                'StatefulHelperProperty'
            );
        }
    }

    private function isInsideFunctionScope(array $conditions)
    {
        foreach ($conditions as $code) {
            if (in_array($code, [T_FUNCTION, T_CLOSURE, T_FN], true)) {
                return true;
            }
        }

        return false;
    }
}
