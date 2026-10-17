/*
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/* Highlight.js 11.11.1 extra grammars. BSD-3-Clause.
 * Copyright (c) 2006, Ivan Sagalaev. All rights reserved.
 * Full license: publication/licenses/highlightjs.txt (public: licenses/highlightjs.txt).
 * Vendored from npm highlight.js@11.11.1/lib/languages; no runtime downloads.
 */
(function(h) {
  if (!h) return;

/*
Language: Dockerfile
Requires: bash.js
Author: Alexis Hénaut <alexis@henaut.net>
Description: language definition for Dockerfile files
Website: https://docs.docker.com/engine/reference/builder/
Category: config
*/

/** @type LanguageFn */
function dockerfile(hljs) {
  const KEYWORDS = [
    "from",
    "maintainer",
    "expose",
    "env",
    "arg",
    "user",
    "onbuild",
    "stopsignal"
  ];
  return {
    name: 'Dockerfile',
    aliases: [ 'docker' ],
    case_insensitive: true,
    keywords: KEYWORDS,
    contains: [
      hljs.HASH_COMMENT_MODE,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.NUMBER_MODE,
      {
        beginKeywords: 'run cmd entrypoint volume add copy workdir label healthcheck shell',
        starts: {
          end: /[^\\]$/,
          subLanguage: 'bash'
        }
      }
    ],
    illegal: '</'
  };
}

h.registerLanguage('dockerfile', dockerfile);

/*
Language: CMake
Description: CMake is an open-source cross-platform system for build automation.
Author: Igor Kalnitsky <igor@kalnitsky.org>
Website: https://cmake.org
Category: build-system
*/

/** @type LanguageFn */
function cmake(hljs) {
  return {
    name: 'CMake',
    aliases: [ 'cmake.in' ],
    case_insensitive: true,
    keywords: { keyword:
        // scripting commands
        'break cmake_host_system_information cmake_minimum_required cmake_parse_arguments '
        + 'cmake_policy configure_file continue elseif else endforeach endfunction endif endmacro '
        + 'endwhile execute_process file find_file find_library find_package find_path '
        + 'find_program foreach function get_cmake_property get_directory_property '
        + 'get_filename_component get_property if include include_guard list macro '
        + 'mark_as_advanced math message option return separate_arguments '
        + 'set_directory_properties set_property set site_name string unset variable_watch while '
        // project commands
        + 'add_compile_definitions add_compile_options add_custom_command add_custom_target '
        + 'add_definitions add_dependencies add_executable add_library add_link_options '
        + 'add_subdirectory add_test aux_source_directory build_command create_test_sourcelist '
        + 'define_property enable_language enable_testing export fltk_wrap_ui '
        + 'get_source_file_property get_target_property get_test_property include_directories '
        + 'include_external_msproject include_regular_expression install link_directories '
        + 'link_libraries load_cache project qt_wrap_cpp qt_wrap_ui remove_definitions '
        + 'set_source_files_properties set_target_properties set_tests_properties source_group '
        + 'target_compile_definitions target_compile_features target_compile_options '
        + 'target_include_directories target_link_directories target_link_libraries '
        + 'target_link_options target_sources try_compile try_run '
        // CTest commands
        + 'ctest_build ctest_configure ctest_coverage ctest_empty_binary_directory ctest_memcheck '
        + 'ctest_read_custom_files ctest_run_script ctest_sleep ctest_start ctest_submit '
        + 'ctest_test ctest_update ctest_upload '
        // deprecated commands
        + 'build_name exec_program export_library_dependencies install_files install_programs '
        + 'install_targets load_command make_directory output_required_files remove '
        + 'subdir_depends subdirs use_mangled_mesa utility_source variable_requires write_file '
        + 'qt5_use_modules qt5_use_package qt5_wrap_cpp '
        // core keywords
        + 'on off true false and or not command policy target test exists is_newer_than '
        + 'is_directory is_symlink is_absolute matches less greater equal less_equal '
        + 'greater_equal strless strgreater strequal strless_equal strgreater_equal version_less '
        + 'version_greater version_equal version_less_equal version_greater_equal in_list defined' },
    contains: [
      {
        className: 'variable',
        begin: /\$\{/,
        end: /\}/
      },
      hljs.COMMENT(/#\[\[/, /]]/),
      hljs.HASH_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      hljs.NUMBER_MODE
    ]
  };
}

h.registerLanguage('cmake', cmake);

/*
Language: LLVM IR
Author: Michael Rodler <contact@f0rki.at>
Description: language used as intermediate representation in the LLVM compiler framework
Website: https://llvm.org/docs/LangRef.html
Category: assembler
Audit: 2020
*/

/** @type LanguageFn */
function llvm(hljs) {
  const regex = hljs.regex;
  const IDENT_RE = /([-a-zA-Z$._][\w$.-]*)/;
  const TYPE = {
    className: 'type',
    begin: /\bi\d+(?=\s|\b)/
  };
  const OPERATOR = {
    className: 'operator',
    relevance: 0,
    begin: /=/
  };
  const PUNCTUATION = {
    className: 'punctuation',
    relevance: 0,
    begin: /,/
  };
  const NUMBER = {
    className: 'number',
    variants: [
      { begin: /[su]?0[xX][KMLHR]?[a-fA-F0-9]+/ },
      { begin: /[-+]?\d+(?:[.]\d+)?(?:[eE][-+]?\d+(?:[.]\d+)?)?/ }
    ],
    relevance: 0
  };
  const LABEL = {
    className: 'symbol',
    variants: [ { begin: /^\s*[a-z]+:/ }, // labels
    ],
    relevance: 0
  };
  const VARIABLE = {
    className: 'variable',
    variants: [
      { begin: regex.concat(/%/, IDENT_RE) },
      { begin: /%\d+/ },
      { begin: /#\d+/ },
    ]
  };
  const FUNCTION = {
    className: 'title',
    variants: [
      { begin: regex.concat(/@/, IDENT_RE) },
      { begin: /@\d+/ },
      { begin: regex.concat(/!/, IDENT_RE) },
      { begin: regex.concat(/!\d+/, IDENT_RE) },
      // https://llvm.org/docs/LangRef.html#namedmetadatastructure
      // obviously a single digit can also be used in this fashion
      { begin: /!\d+/ }
    ]
  };

  return {
    name: 'LLVM IR',
    // TODO: split into different categories of keywords
    keywords: {
      keyword: 'begin end true false declare define global '
        + 'constant private linker_private internal '
        + 'available_externally linkonce linkonce_odr weak '
        + 'weak_odr appending dllimport dllexport common '
        + 'default hidden protected extern_weak external '
        + 'thread_local zeroinitializer undef null to tail '
        + 'target triple datalayout volatile nuw nsw nnan '
        + 'ninf nsz arcp fast exact inbounds align '
        + 'addrspace section alias module asm sideeffect '
        + 'gc dbg linker_private_weak attributes blockaddress '
        + 'initialexec localdynamic localexec prefix unnamed_addr '
        + 'ccc fastcc coldcc x86_stdcallcc x86_fastcallcc '
        + 'arm_apcscc arm_aapcscc arm_aapcs_vfpcc ptx_device '
        + 'ptx_kernel intel_ocl_bicc msp430_intrcc spir_func '
        + 'spir_kernel x86_64_sysvcc x86_64_win64cc x86_thiscallcc '
        + 'cc c signext zeroext inreg sret nounwind '
        + 'noreturn noalias nocapture byval nest readnone '
        + 'readonly inlinehint noinline alwaysinline optsize ssp '
        + 'sspreq noredzone noimplicitfloat naked builtin cold '
        + 'nobuiltin noduplicate nonlazybind optnone returns_twice '
        + 'sanitize_address sanitize_memory sanitize_thread sspstrong '
        + 'uwtable returned type opaque eq ne slt sgt '
        + 'sle sge ult ugt ule uge oeq one olt ogt '
        + 'ole oge ord uno ueq une x acq_rel acquire '
        + 'alignstack atomic catch cleanup filter inteldialect '
        + 'max min monotonic nand personality release seq_cst '
        + 'singlethread umax umin unordered xchg add fadd '
        + 'sub fsub mul fmul udiv sdiv fdiv urem srem '
        + 'frem shl lshr ashr and or xor icmp fcmp '
        + 'phi call trunc zext sext fptrunc fpext uitofp '
        + 'sitofp fptoui fptosi inttoptr ptrtoint bitcast '
        + 'addrspacecast select va_arg ret br switch invoke '
        + 'unwind unreachable indirectbr landingpad resume '
        + 'malloc alloca free load store getelementptr '
        + 'extractelement insertelement shufflevector getresult '
        + 'extractvalue insertvalue atomicrmw cmpxchg fence '
        + 'argmemonly',
      type: 'void half bfloat float double fp128 x86_fp80 ppc_fp128 '
        + 'x86_amx x86_mmx ptr label token metadata opaque'
    },
    contains: [
      TYPE,
      // this matches "empty comments"...
      // ...because it's far more likely this is a statement terminator in
      // another language than an actual comment
      hljs.COMMENT(/;\s*$/, null, { relevance: 0 }),
      hljs.COMMENT(/;/, /$/),
      {
        className: 'string',
        begin: /"/,
        end: /"/,
        contains: [
          {
            className: 'char.escape',
            match: /\\\d\d/
          }
        ]
      },
      FUNCTION,
      PUNCTUATION,
      OPERATOR,
      VARIABLE,
      LABEL,
      NUMBER
    ]
  };
}

h.registerLanguage('llvm', llvm);

})(typeof hljs === 'undefined' ? null : hljs);
