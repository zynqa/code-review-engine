<?php

declare(strict_types=1);

class Zynqa_Sniffs_Controllers_AdminhtmlControllerSniff implements PHP_CodeSniffer\Sniffs\Sniff
{
    public function register()
    {
        return [T_CLASS];
    }

    public function process(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $fileName = str_replace('\\', '/', $phpcsFile->getFilename());
        if (strpos($fileName, '/Controller/Adminhtml/') === false) {
            return;
        }

        $tokens = $phpcsFile->getTokens();
        $classToken = $tokens[$stackPtr];
        if (empty($classToken['scope_opener']) || empty($classToken['scope_closer'])) {
            return;
        }

        if (!$this->extendsBackendAction($phpcsFile, $stackPtr)) {
            $phpcsFile->addError(
                'Adminhtml controllers must extend Magento\\Backend\\App\\Action.',
                $stackPtr,
                'InvalidAdminhtmlControllerBaseClass'
            );
        }

        if (!$this->hasAdminResourceConst($tokens, $classToken['scope_opener'], $classToken['scope_closer'])) {
            $phpcsFile->addError(
                'Adminhtml controllers must declare an ADMIN_RESOURCE constant.',
                $stackPtr,
                'MissingAdminResource'
            );
        }
    }

    private function extendsBackendAction(PHP_CodeSniffer\Files\File $phpcsFile, $stackPtr)
    {
        $contents = $phpcsFile->getTokensAsString(0, count($phpcsFile->getTokens()));
        if (!preg_match('/class\s+\w+\s+extends\s+([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)/m', $contents, $matches)) {
            return false;
        }

        $normalized = ltrim(str_replace('\\\\', '\\', $matches[1]), '\\');
        if ($normalized === 'Magento\Backend\App\Action') {
            return true;
        }

        if (strpos($normalized, '\\') !== false) {
            return false;
        }

        return $normalized === $this->resolveBackendActionAlias($phpcsFile);
    }

    private function hasAdminResourceConst(array $tokens, $scopeOpener, $scopeCloser)
    {
        for ($ptr = $scopeOpener + 1; $ptr < $scopeCloser; $ptr++) {
            if ($tokens[$ptr]['code'] !== T_CONST) {
                continue;
            }

            $namePtr = $this->findNextNonWhitespace($tokens, $ptr + 1, $scopeCloser);
            if ($namePtr !== false && $tokens[$namePtr]['content'] === 'ADMIN_RESOURCE') {
                return true;
            }
        }

        return false;
    }

    private function findNextNonWhitespace(array $tokens, $start, $end)
    {
        for ($ptr = $start; $ptr < $end; $ptr++) {
            if ($tokens[$ptr]['code'] !== T_WHITESPACE) {
                return $ptr;
            }
        }

        return false;
    }

    private function resolveBackendActionAlias(PHP_CodeSniffer\Files\File $phpcsFile): string
    {
        $contents = $phpcsFile->getTokensAsString(0, count($phpcsFile->getTokens()));
        if (!preg_match('/use\s+Magento\\\\Backend\\\\App\\\\Action(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;/m', $contents, $matches)) {
            return '';
        }

        return !empty($matches[1]) ? $matches[1] : 'Action';
    }
}
