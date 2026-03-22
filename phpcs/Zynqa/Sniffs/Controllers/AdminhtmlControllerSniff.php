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
        $tokens = $phpcsFile->getTokens();
        $extendsPtr = $phpcsFile->findNext(T_EXTENDS, $stackPtr + 1, null, false, null, true);
        if ($extendsPtr === false) {
            return false;
        }

        $classToken = $tokens[$stackPtr];
        if (!empty($classToken['scope_opener']) && $extendsPtr > $classToken['scope_opener']) {
            return false;
        }

        $name = '';
        for ($ptr = $extendsPtr + 1; $ptr < count($tokens); $ptr++) {
            if (in_array($tokens[$ptr]['code'], [T_WHITESPACE, T_NS_SEPARATOR, T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED], true)) {
                $name .= $tokens[$ptr]['content'];
                continue;
            }

            break;
        }

        $normalized = ltrim(str_replace('\\\\', '\\', $name), '\\');

        return $normalized === 'Magento\Backend\App\Action';
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
}
